import { toast } from "react-toastify";

const TEXT = "This device's storage is full, so your last change wasn't saved.";

/**
 * An edit couldn't be queued on this device: its storage is full even after
 * dropping the copies kept of other sessions (see writePendingQueue). Says
 * so; with `retry`, which queues it again and returns whether that's done,
 * until it is: meanwhile the edit holds the board (see queueEdit).
 */
export function sayStorageFull(retry?: () => boolean): void {
    if (!retry) {
        toast.error(TEXT, { toastId: "storage-full", autoClose: false });
        return;
    }
    toast.error(
        ({ closeToast }) => (
            <div className="flex w-full items-center gap-2">
                <span className="min-w-0 flex-1 break-words">{TEXT}</span>
                <button
                    className="min-h-9 shrink-0 rounded-md border border-current px-3 text-sm font-semibold"
                    onClick={() => {
                        if (retry()) closeToast();
                    }}
                >
                    Retry
                </button>
            </div>
        ),
        {
            toastId: "storage-full-retry",
            autoClose: false,
            closeButton: false,
            closeOnClick: false,
        },
    );
}
