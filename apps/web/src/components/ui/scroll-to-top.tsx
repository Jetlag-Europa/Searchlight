import { type RefObject, useEffect, useState } from "react";
import { MdOutlineVerticalAlignTop } from "react-icons/md";

import { Button } from "@/components/ui/button";

/** A button that scrolls `element` back to the top once it is scrolled `minHeight` down. */
export function ScrollToTop({
    minHeight,
    element,
}: {
    minHeight: number;
    element: RefObject<HTMLDivElement | null>;
}) {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const scroller = element.current;
        if (!scroller) return;
        const onScroll = () => setVisible(scroller.scrollTop >= minHeight);
        onScroll();
        scroller.addEventListener("scroll", onScroll);
        return () => scroller.removeEventListener("scroll", onScroll);
    }, []);

    return (
        <>
            {visible && (
                <Button
                    onClick={() =>
                        element.current?.scrollTo({
                            top: 0,
                            behavior: "smooth",
                        })
                    }
                    variant="ghost"
                    className="fixed rounded-full right-2 w-12 h-12 z-[1050] hover:bg-slate-500 p-1"
                >
                    <MdOutlineVerticalAlignTop className="!w-1/2 !h-1/2 " />
                </Button>
            )}
        </>
    );
}
