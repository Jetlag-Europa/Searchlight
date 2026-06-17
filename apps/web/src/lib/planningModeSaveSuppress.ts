let count = 0;

export function suppressNextPlanningModeSave(): void {
    count++;
}

export function shouldSuppressPlanningModeSave(): boolean {
    if (count > 0) {
        count--;
        return true;
    }
    return false;
}
