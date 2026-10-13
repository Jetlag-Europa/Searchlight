// Question lists published by SSE or by game-definition filtering rather than
// by a local edit. SessionManager's save effect skips them by identity: a
// count would leak when several sets render once (a replay page, or a filter
// right before a session load's own set) and swallow the next real edit.
// Local edits always publish a new array (see questionModified).
const suppressed = new WeakSet<object>();

export function suppressQuestionSave<T extends object>(questions: T): T {
    suppressed.add(questions);
    return questions;
}

export function isQuestionSaveSuppressed(questions: object): boolean {
    return suppressed.has(questions);
}
