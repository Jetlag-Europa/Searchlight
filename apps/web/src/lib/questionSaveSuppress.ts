// Counter-based suppress flag shared between sseManager and SessionManager.
// sseManager increments before applying a remote questions.replace;
// SessionManager drains one count per useEffect fire instead of saving.
let count = 0;

export function suppressNextQuestionSave(): void {
    count++;
}

export function shouldSuppressQuestionSave(): boolean {
    if (count > 0) {
        count--;
        return true;
    }
    return false;
}
