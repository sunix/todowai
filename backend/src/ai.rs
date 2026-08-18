use serde::{Deserialize, Serialize};

/// Providers a user can pick from Settings — the 5 most popular hosted APIs plus a local/
/// self-hosted option, per #17. Anthropic gets its own adapter (native Messages API); the rest
/// share one generic OpenAI-compatible adapter, since OpenAI, Gemini, Mistral, Groq, and Ollama
/// all expose (or emulate) the same `/chat/completions` request/response shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    Anthropic,
    Openai,
    Gemini,
    Mistral,
    Groq,
    Ollama,
}

impl AiProvider {
    /// Parses the `TODOWAI_AI_PROVIDER` env var (main.rs) — same casing as the JSON wire format.
    pub fn parse_env_value(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "anthropic" => Some(AiProvider::Anthropic),
            "openai" => Some(AiProvider::Openai),
            "gemini" => Some(AiProvider::Gemini),
            "mistral" => Some(AiProvider::Mistral),
            "groq" => Some(AiProvider::Groq),
            "ollama" => Some(AiProvider::Ollama),
            _ => None,
        }
    }
}

/// Kept in memory only, same rationale as RemoteConfig — never persisted, never echoed back
/// with the key intact (see api::get_ai_config).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub provider: AiProvider,
    /// Empty for Ollama (no key needed for a local, unauthenticated server).
    pub api_key: String,
    /// Required for every OpenAI-compatible provider (no safe default model to guess); optional
    /// for Anthropic, which defaults to Claude Opus 5.
    pub model: Option<String>,
    /// Overrides the provider's default endpoint — mainly for Ollama (a different host/port) or
    /// a self-hosted OpenAI-compatible server.
    pub base_url: Option<String>,
}

/// The safe-to-echo half of AiConfig — never includes the API key, matching how RemoteConfig's
/// token is never sent back to the browser (see repository.rs's RemoteConfig doc comment).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigView {
    pub provider: Option<AiProvider>,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub configured: bool,
}

impl AiConfigView {
    pub fn from_config(config: Option<&AiConfig>) -> Self {
        match config {
            Some(config) => AiConfigView {
                provider: Some(config.provider),
                model: config.model.clone(),
                base_url: config.base_url.clone(),
                configured: true,
            },
            None => AiConfigView {
                provider: None,
                model: None,
                base_url: None,
                configured: false,
            },
        }
    }
}

/// What the AI proposes for a captured note — mirrors the manual filing draft's shape (see
/// app/src/screens.ts's CaptureDraft) so the frontend can reuse the same draft panel for both
/// the manual and AI-proposed paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiClassification {
    #[serde(rename = "type")]
    pub note_type: String,
    pub title: String,
    pub content: String,
}

#[derive(Debug)]
pub enum AiError {
    NotConfigured,
    /// A misconfiguration only the caller can fix (e.g. no model set for a provider that
    /// requires one) — distinct from a request that reached the provider and failed there.
    Configuration(String),
    Request(String),
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AiError::NotConfigured => write!(f, "no AI provider is configured"),
            AiError::Configuration(message) => write!(f, "{message}"),
            AiError::Request(message) => write!(f, "{message}"),
        }
    }
}

const PROMPT_TEMPLATE: &str = r#"You are classifying a quickly captured note into a structured Todowai item.

Captured text:
"""
{TEXT}
"""

Respond with ONLY a single JSON object, no other text, no markdown code fences, matching exactly this shape:
{"type": "todo | meeting | status | project", "title": "short descriptive title, under 60 characters", "content": "the note body, including a YAML frontmatter block (---\ntype: <type>\nstatus: backlog\n---\n\n) followed by the captured text, lightly cleaned up if it helps"}

Pick whichever type best fits the captured text. Keep the frontmatter's type field consistent with your chosen type."#;

fn build_prompt(text: &str) -> String {
    PROMPT_TEMPLATE.replace("{TEXT}", text)
}

/// Fetched fresh from the provider each time (not cached) — the model catalog can change
/// between saves, and this is a cheap, infrequent call (Settings loading, not the hot path).
pub async fn list_models(config: &AiConfig) -> Result<Vec<String>, AiError> {
    match config.provider {
        AiProvider::Anthropic => list_models_via_anthropic(config).await,
        AiProvider::Openai => list_models_via_openai_compatible(config, "https://api.openai.com/v1").await,
        AiProvider::Gemini => {
            list_models_via_openai_compatible(config, "https://generativelanguage.googleapis.com/v1beta/openai").await
        }
        AiProvider::Mistral => list_models_via_openai_compatible(config, "https://api.mistral.ai/v1").await,
        AiProvider::Groq => list_models_via_openai_compatible(config, "https://api.groq.com/openai/v1").await,
        AiProvider::Ollama => list_models_via_openai_compatible(config, "http://localhost:11434/v1").await,
    }
}

async fn list_models_via_anthropic(config: &AiConfig) -> Result<Vec<String>, AiError> {
    let client = reqwest::Client::new();
    let response = client
        .get("https://api.anthropic.com/v1/models")
        .header("x-api-key", &config.api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|error| AiError::Request(format!("could not reach Anthropic: {error}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        return Err(AiError::Request(format!("Anthropic API error ({status}): {body_text}")));
    }

    let parsed: serde_json::Value = response
        .json()
        .await
        .map_err(|error| AiError::Request(format!("could not parse Anthropic's response: {error}")))?;

    Ok(extract_model_ids(&parsed))
}

/// Same `/models` shape across OpenAI, Gemini, Mistral, Groq, and Ollama — mirrors the
/// `/chat/completions` adapter these providers already share.
async fn list_models_via_openai_compatible(config: &AiConfig, default_base_url: &str) -> Result<Vec<String>, AiError> {
    let base_url = resolve_base_url(config, default_base_url);
    let client = reqwest::Client::new();
    let mut request = client.get(format!("{}/models", base_url.trim_end_matches('/')));
    if !config.api_key.trim().is_empty() {
        request = request.header("authorization", format!("Bearer {}", config.api_key));
    }

    let response = request
        .send()
        .await
        .map_err(|error| AiError::Request(format!("could not reach {base_url}: {error}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        return Err(AiError::Request(format!("provider returned an error ({status}): {body_text}")));
    }

    let parsed: serde_json::Value = response
        .json()
        .await
        .map_err(|error| AiError::Request(format!("could not parse the provider's response: {error}")))?;

    Ok(extract_model_ids(&parsed))
}

/// Both Anthropic's `/models` and the OpenAI-compatible `/models` return `{ "data": [{"id": ...}, ...] }`.
fn extract_model_ids(response: &serde_json::Value) -> Vec<String> {
    response
        .get("data")
        .and_then(|value| value.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.get("id").and_then(|id| id.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn resolve_base_url(config: &AiConfig, default_base_url: &str) -> String {
    config
        .base_url
        .clone()
        .filter(|url| !url.trim().is_empty())
        .unwrap_or_else(|| default_base_url.to_string())
}

pub async fn classify(text: &str, config: &AiConfig) -> Result<AiClassification, AiError> {
    let prompt = build_prompt(text);
    let raw = complete(&prompt, config).await?;
    parse_classification(&raw)
}

/// A single note considered for a next-action suggestion — just enough to describe it in a
/// prompt, not the full Snapshot shape the rest of the app uses.
pub struct BacklogNote {
    pub path: String,
    pub content: String,
}

/// Mirrors AiClassification's role: what the AI proposes, kept separate from anything actually
/// being written — Next Action's "Confirm" step (not this call) is what makes it real, matching
/// the confirm-first pattern used everywhere else AI touches the vault.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NextActionSuggestion {
    pub suggestion: String,
}

/// Truncated per note (not the whole prompt) so one runaway-long backlog item can't crowd out
/// every other candidate the AI should be considering.
const MAX_NOTE_CHARS_IN_PROMPT: usize = 500;

fn truncate_for_prompt(content: &str) -> String {
    let trimmed = content.trim();
    if trimmed.chars().count() <= MAX_NOTE_CHARS_IN_PROMPT {
        return trimmed.to_string();
    }
    let truncated: String = trimmed.chars().take(MAX_NOTE_CHARS_IN_PROMPT).collect();
    format!("{truncated}…")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatusKind {
    Situational,
    Task,
}

/// Mirrors the minimal frontmatter subset app/src/frontmatter.ts parses on the frontend (#18) —
/// just enough to pull out status.md's `kind` field (#19) and its free-text label/body, not a
/// general-purpose YAML parser (nothing else in the backend needs one). `raw` is status.md's
/// whole file content, frontmatter fence included.
fn parse_status(raw: &str) -> (Option<StatusKind>, String) {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return (None, raw.trim().to_string());
    }

    let mut lines = trimmed.lines();
    lines.next(); // opening fence
    let mut kind = None;
    for line in lines.by_ref() {
        if line.trim() == "---" {
            break;
        }
        if let Some(value) = line.strip_prefix("kind:") {
            kind = match value.trim() {
                "situational" => Some(StatusKind::Situational),
                "task" => Some(StatusKind::Task),
                _ => None,
            };
        }
    }
    let body: String = lines.collect::<Vec<_>>().join("\n");
    (kind, body.trim().to_string())
}

fn build_suggestion_prompt(status: Option<&str>, backlog_notes: &[BacklogNote], excluded_suggestions: &[String]) -> String {
    let mut prompt = String::from(
        "You are helping a user decide what to do next, based on their current status and their backlog notes.\n\n",
    );

    let (status_kind, status_label) = match status {
        Some(raw) if !raw.trim().is_empty() => {
            let (kind, label) = parse_status(raw);
            (kind, (!label.is_empty()).then_some(label))
        }
        _ => (None, None),
    };

    match &status_label {
        Some(label) => prompt.push_str(&format!("Current status: {label}\n\n")),
        None => prompt.push_str("Current status: not set\n\n"),
    }

    // #21: a situational status (a short break or passive moment) should bias toward something
    // small enough to fit that moment; a task-linked status gets no special treatment — the
    // baseline behavior below already suggests a normal next todo.
    if status_kind == Some(StatusKind::Situational) {
        prompt.push_str(
            "The current status is a situational context (a short break or passive moment), not an \
             active work task. Bias your suggestion toward something small and quick that fits a short \
             moment — e.g. a brief look at a side project, reading one page of a book — rather than a \
             large or involved task, even if a bigger backlog item would otherwise fit.\n\n",
        );
    }

    if backlog_notes.is_empty() {
        prompt.push_str("Backlog notes: (none)\n\n");
    } else {
        prompt.push_str("Backlog notes:\n");
        for note in backlog_notes {
            prompt.push_str(&format!("- {}:\n{}\n\n", note.path, truncate_for_prompt(&note.content)));
        }
    }

    if !excluded_suggestions.is_empty() {
        prompt.push_str("Already suggested and rejected this session — propose something different:\n");
        for item in excluded_suggestions {
            prompt.push_str(&format!("- {item}\n"));
        }
        prompt.push('\n');
    }

    prompt.push_str(
        "Respond with ONLY a single JSON object, no other text, no markdown code fences, matching exactly this shape:\n\
         {\"suggestion\": \"a short, concrete next action, phrased as something to do right now\"}\n\n\
         Prefer picking something grounded in one of the backlog notes above when one fits well; only propose \
         something else if nothing in the backlog fits.",
    );

    prompt
}

pub async fn suggest_next_action(
    status: Option<&str>,
    backlog_notes: &[BacklogNote],
    excluded_suggestions: &[String],
    config: &AiConfig,
) -> Result<NextActionSuggestion, AiError> {
    let prompt = build_suggestion_prompt(status, backlog_notes, excluded_suggestions);
    let raw = complete(&prompt, config).await?;
    parse_suggestion(&raw)
}

/// Provider dispatch shared by every prompt-and-parse-JSON call this module makes (classify,
/// suggest_next_action, and any future one) — the underlying adapters just send a prompt and
/// hand back raw text; what the prompt asks for and how the response is parsed is the caller's
/// concern, not this dispatch's.
async fn complete(prompt: &str, config: &AiConfig) -> Result<String, AiError> {
    match config.provider {
        AiProvider::Anthropic => complete_via_anthropic(prompt, config).await,
        AiProvider::Openai => complete_via_openai_compatible(prompt, config, "https://api.openai.com/v1").await,
        AiProvider::Gemini => {
            complete_via_openai_compatible(prompt, config, "https://generativelanguage.googleapis.com/v1beta/openai").await
        }
        AiProvider::Mistral => complete_via_openai_compatible(prompt, config, "https://api.mistral.ai/v1").await,
        AiProvider::Groq => complete_via_openai_compatible(prompt, config, "https://api.groq.com/openai/v1").await,
        AiProvider::Ollama => complete_via_openai_compatible(prompt, config, "http://localhost:11434/v1").await,
    }
}

/// Native Anthropic Messages API — kept separate from the OpenAI-compatible adapter since its
/// request/response shape (and refusal handling) differ from every other provider here.
async fn complete_via_anthropic(prompt: &str, config: &AiConfig) -> Result<String, AiError> {
    let model = config.model.clone().unwrap_or_else(|| "claude-opus-5".to_string());
    let client = reqwest::Client::new();

    // Thinking off + low effort: this is a quick, latency-sensitive classification, not an
    // open-ended reasoning task — matches the "short, scoped, not intelligence-sensitive" case
    // for low effort, not a downgrade of the model itself.
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 2048,
        "thinking": {"type": "disabled"},
        "output_config": {"effort": "low"},
        "messages": [{"role": "user", "content": prompt}],
    });

    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &config.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| AiError::Request(format!("could not reach Anthropic: {error}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        return Err(AiError::Request(format!("Anthropic API error ({status}): {body_text}")));
    }

    let parsed: serde_json::Value = response
        .json()
        .await
        .map_err(|error| AiError::Request(format!("could not parse Anthropic's response: {error}")))?;

    // A real HTTP 200 can still be a policy decline — branch on stop_reason before reading
    // content, never assume content[0] exists.
    if parsed.get("stop_reason").and_then(|value| value.as_str()) == Some("refusal") {
        return Err(AiError::Request(
            "Anthropic declined this request (safety classifier) — try rephrasing the captured note.".to_string(),
        ));
    }

    parsed
        .get("content")
        .and_then(|value| value.as_array())
        .and_then(|blocks| blocks.iter().find(|block| block.get("type").and_then(|t| t.as_str()) == Some("text")))
        .and_then(|block| block.get("text"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| AiError::Request("Anthropic's response had no text content".to_string()))
}

/// Covers OpenAI, Google Gemini (via its OpenAI-compatible endpoint), Mistral, Groq, and Ollama
/// (local) — all speak the same `/chat/completions` request/response shape, differing only in
/// base URL and whether an API key is required at all (Ollama needs none).
async fn complete_via_openai_compatible(prompt: &str, config: &AiConfig, default_base_url: &str) -> Result<String, AiError> {
    let model = config
        .model
        .clone()
        .filter(|model| !model.trim().is_empty())
        .ok_or_else(|| AiError::Configuration("a model name is required for this provider".to_string()))?;

    let base_url = resolve_base_url(config, default_base_url);

    let client = reqwest::Client::new();
    let mut request = client
        .post(format!("{}/chat/completions", base_url.trim_end_matches('/')))
        .header("content-type", "application/json");
    if !config.api_key.trim().is_empty() {
        request = request.header("authorization", format!("Bearer {}", config.api_key));
    }

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 2048,
        "messages": [{"role": "user", "content": prompt}],
    });

    let response = request
        .json(&body)
        .send()
        .await
        .map_err(|error| AiError::Request(format!("could not reach {base_url}: {error}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        return Err(AiError::Request(format!("provider returned an error ({status}): {body_text}")));
    }

    let parsed: serde_json::Value = response
        .json()
        .await
        .map_err(|error| AiError::Request(format!("could not parse the provider's response: {error}")))?;

    parsed
        .get("choices")
        .and_then(|value| value.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| AiError::Request("the provider's response had no message content".to_string()))
}

/// Models often wrap JSON in a markdown code fence despite being asked not to — strip one if
/// present rather than failing outright.
fn strip_json_fence(raw: &str) -> &str {
    let mut text = raw.trim();
    if let Some(rest) = text.strip_prefix("```json") {
        text = rest.trim();
    } else if let Some(rest) = text.strip_prefix("```") {
        text = rest.trim();
    }
    if let Some(rest) = text.strip_suffix("```") {
        text = rest.trim();
    }
    text
}

fn parse_classification(raw: &str) -> Result<AiClassification, AiError> {
    serde_json::from_str(strip_json_fence(raw))
        .map_err(|error| AiError::Request(format!("could not parse the model's response as JSON: {error}")))
}

fn parse_suggestion(raw: &str) -> Result<NextActionSuggestion, AiError> {
    serde_json::from_str(strip_json_fence(raw))
        .map_err(|error| AiError::Request(format!("could not parse the model's response as JSON: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_classification_accepts_plain_json() {
        let result = parse_classification(
            r#"{"type": "todo", "title": "Client X migration", "content": "---\ntype: todo\nstatus: backlog\n---\n\nbody"}"#,
        )
        .unwrap();
        assert_eq!(result.note_type, "todo");
        assert_eq!(result.title, "Client X migration");
    }

    #[test]
    fn parse_classification_strips_markdown_fences() {
        let raw = "```json\n{\"type\": \"meeting\", \"title\": \"Standup\", \"content\": \"body\"}\n```";
        let result = parse_classification(raw).unwrap();
        assert_eq!(result.note_type, "meeting");
        assert_eq!(result.title, "Standup");
    }

    #[test]
    fn parse_classification_rejects_non_json() {
        assert!(parse_classification("not json at all").is_err());
    }

    #[test]
    fn extract_model_ids_reads_the_shared_openai_style_shape() {
        let response = serde_json::json!({
            "object": "list",
            "data": [
                {"id": "gpt-4o-mini", "object": "model"},
                {"id": "gemma4:26b", "object": "model"},
            ],
        });
        assert_eq!(extract_model_ids(&response), vec!["gpt-4o-mini", "gemma4:26b"]);
    }

    #[test]
    fn extract_model_ids_defaults_to_empty_on_an_unexpected_shape() {
        let response = serde_json::json!({ "unexpected": true });
        assert!(extract_model_ids(&response).is_empty());
    }

    #[test]
    fn parse_suggestion_accepts_plain_json() {
        let result = parse_suggestion(r#"{"suggestion": "Write the Q3 report"}"#).unwrap();
        assert_eq!(result.suggestion, "Write the Q3 report");
    }

    #[test]
    fn parse_suggestion_strips_markdown_fences() {
        let raw = "```json\n{\"suggestion\": \"Fix the login bug\"}\n```";
        assert_eq!(parse_suggestion(raw).unwrap().suggestion, "Fix the login bug");
    }

    #[test]
    fn suggestion_prompt_reports_no_status_when_unset() {
        let prompt = build_suggestion_prompt(None, &[], &[]);
        assert!(prompt.contains("Current status: not set"));
        assert!(prompt.contains("Backlog notes: (none)"));
    }

    #[test]
    fn suggestion_prompt_includes_status_and_backlog_notes() {
        let notes = [BacklogNote {
            path: "todowai/backlog/write-report.md".to_string(),
            content: "---\ntype: todo\nstatus: backlog\n---\n\nWrite the Q3 report.".to_string(),
        }];
        let prompt = build_suggestion_prompt(Some("Coffee break"), &notes, &[]);
        assert!(prompt.contains("Current status: Coffee break"));
        assert!(prompt.contains("todowai/backlog/write-report.md"));
        assert!(prompt.contains("Write the Q3 report."));
    }

    #[test]
    fn suggestion_prompt_lists_excluded_suggestions_to_avoid_repeats() {
        let excluded = vec!["Write the Q3 report".to_string()];
        let prompt = build_suggestion_prompt(None, &[], &excluded);
        assert!(prompt.contains("Write the Q3 report"));
        assert!(prompt.contains("propose something different"));
    }

    #[test]
    fn truncate_for_prompt_leaves_short_content_untouched() {
        assert_eq!(truncate_for_prompt("short note"), "short note");
    }

    #[test]
    fn truncate_for_prompt_caps_long_content() {
        let long_content = "a".repeat(MAX_NOTE_CHARS_IN_PROMPT + 100);
        let truncated = truncate_for_prompt(&long_content);
        assert_eq!(truncated.chars().count(), MAX_NOTE_CHARS_IN_PROMPT + 1); // +1 for the "…" marker
        assert!(truncated.ends_with('…'));
    }

    #[test]
    fn parse_status_extracts_situational_kind_and_label() {
        let raw = "---\nkind: situational\n---\n\nCoffee break";
        let (kind, label) = parse_status(raw);
        assert_eq!(kind, Some(StatusKind::Situational));
        assert_eq!(label, "Coffee break");
    }

    #[test]
    fn parse_status_extracts_task_kind_and_label_ignoring_other_fields() {
        let raw = "---\nkind: task\ntask: todowai/doing/fix-login-bug.md\n---\n\nfix-login-bug";
        let (kind, label) = parse_status(raw);
        assert_eq!(kind, Some(StatusKind::Task));
        assert_eq!(label, "fix-login-bug");
    }

    #[test]
    fn parse_status_returns_none_kind_for_content_with_no_frontmatter() {
        let (kind, label) = parse_status("just some text, no frontmatter");
        assert_eq!(kind, None);
        assert_eq!(label, "just some text, no frontmatter");
    }

    #[test]
    fn suggestion_prompt_biases_toward_small_items_for_situational_status() {
        let raw_status = "---\nkind: situational\n---\n\nCoffee break";
        let prompt = build_suggestion_prompt(Some(raw_status), &[], &[]);
        assert!(prompt.contains("Current status: Coffee break"));
        assert!(prompt.contains("small and quick"));
    }

    #[test]
    fn suggestion_prompt_has_no_special_bias_for_task_status() {
        let raw_status = "---\nkind: task\ntask: todowai/doing/fix-login-bug.md\n---\n\nfix-login-bug";
        let prompt = build_suggestion_prompt(Some(raw_status), &[], &[]);
        assert!(prompt.contains("Current status: fix-login-bug"));
        assert!(!prompt.contains("small and quick"));
    }

    #[test]
    fn suggestion_prompt_has_no_special_bias_when_status_is_unset() {
        let prompt = build_suggestion_prompt(None, &[], &[]);
        assert!(!prompt.contains("small and quick"));
    }
}
