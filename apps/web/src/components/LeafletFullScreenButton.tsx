import { useEffect, useState } from "react";
import { AiOutlineFullscreen, AiOutlineFullscreenExit } from "react-icons/ai";

export const LeafletFullScreenButton = () => {
    const [isFullScreen, setIsFullScreen] = useState<boolean>(
        () => !!document.fullscreenElement,
    );

    // Follows Esc and other ways out of full screen, not only this button.
    useEffect(() => {
        const sync = () => setIsFullScreen(!!document.fullscreenElement);
        document.addEventListener("fullscreenchange", sync);
        return () => document.removeEventListener("fullscreenchange", sync);
    }, []);

    // iPhone Safari has no Fullscreen API for elements.
    if (!document.fullscreenEnabled) return null;

    const label = isFullScreen ? "Exit full screen" : "Full screen";

    return (
        <button
            type="button"
            title={label}
            aria-label={label}
            className="leaflet-full-screen-specific-name bg-white hover:bg-[#f4f4f4] w-[30px] h-[30px] rounded-sm leading-[30px] text-[22px] flex items-center justify-center border-2 border-black border-opacity-30 cursor-pointer"
            onClick={() => {
                const dialogContainer: HTMLDivElement | null =
                    document.querySelector(
                        "#map-modal-dialog-container-leaflet",
                    );

                if (!document.fullscreenElement) {
                    dialogContainer?.requestFullscreen().catch(() => {});
                } else {
                    document.exitFullscreen().catch(() => {});
                }
            }}
        >
            {isFullScreen ? (
                <AiOutlineFullscreenExit className="w-6 h-6 text-black" />
            ) : (
                <AiOutlineFullscreen className="w-6 h-6 text-black" />
            )}
        </button>
    );
};
