pub(crate) fn compact_chars_middle(value: &str, limit: usize) -> String {
    let trimmed = value.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= limit {
        return trimmed.to_owned();
    }

    let head_len = limit.saturating_mul(2) / 3;
    let tail_len = limit.saturating_sub(head_len);
    let omitted = chars.len().saturating_sub(head_len + tail_len);
    let head = chars.iter().take(head_len).collect::<String>();
    let tail = chars
        .iter()
        .skip(chars.len().saturating_sub(tail_len))
        .collect::<String>();
    format!("{head}\n\n[... Lantor omitted {omitted} chars to keep agent context bounded ...]\n\n{tail}")
}
