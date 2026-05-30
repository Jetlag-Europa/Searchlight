let count = 0;

export function suppressNextHiderSave(): void {
    count++;
}

export function shouldSuppressHiderSave(): boolean {
    if (count > 0) {
        count--;
        return true;
    }
    return false;
}
