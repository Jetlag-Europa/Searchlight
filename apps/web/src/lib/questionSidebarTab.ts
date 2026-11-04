import { atom } from "nanostores";

import { sidebarContextL } from "@/lib/context";

type QuestionSidebarTab = "questions" | "history";

/** Which list the questions sidebar shows: the cards, or their History. */
export const questionSidebarTab = atom<QuestionSidebarTab>("questions");

/**
 * The question whose card the sidebar is to show, until it has: it scrolls
 * there once the cards are drawn (see QuestionSidebar).
 */
export const questionCardToShow = atom<number | null>(null);

/**
 * Shows a question's card: the sidebar opened on its Questions tab,
 * scrolled to it.
 */
export function showQuestionCard(key: number): void {
    questionSidebarTab.set("questions");
    questionCardToShow.set(key);
    const sidebar = sidebarContextL.get();
    if (sidebar.isMobile) {
        if (!sidebar.openMobile) sidebar.setOpenMobile(true);
    } else if (!sidebar.open) {
        sidebar.setOpen(true);
    }
}
