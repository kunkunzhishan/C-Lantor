pub(crate) fn thread_followup_context_rule() -> &'static str {
    "For thread follow-ups or contextual references like continue/this fix/that change/above/same issue/继续/这样修/上面/这个, use the current injected thread context and memory before answering unless the needed same-thread context is already present; use history-read on the default reply target only when memory/current context is insufficient or exact source evidence is needed."
}
