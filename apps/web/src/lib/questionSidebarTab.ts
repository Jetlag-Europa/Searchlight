import { atom } from "nanostores";

export type QuestionSidebarTab = "questions" | "history";

/** Which list the questions sidebar shows: the cards, or their History. */
export const questionSidebarTab = atom<QuestionSidebarTab>("questions");

/** Shows a question's card: the Questions tab, scrolled to it. */
export function showQuestionCard(key: number): void {
    questionSidebarTab.set("questions");
    // Once the cards are drawn in place of the History.
    setTimeout(() => {
        document
            .querySelector(`[data-question-key="${String(key)}"]`)
            ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 50);
}
