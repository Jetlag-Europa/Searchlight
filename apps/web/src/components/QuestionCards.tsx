import type { Question } from "@/maps/schema";

import { MatchingQuestionComponent } from "./cards/matching";
import { MeasuringQuestionComponent } from "./cards/measuring";
import { RadiusQuestionComponent } from "./cards/radius";
import { TentacleQuestionComponent } from "./cards/tentacles";
import { ThermometerQuestionComponent } from "./cards/thermometer";
import { ZoneSizeComponent } from "./cards/zoneSize";

/** A question's card, for its type: in the sidebar, and a marker's dialog. */
export const CardForQuestion = ({
    question,
    sub,
}: {
    question: Question;
    sub?: string;
}) => {
    const questionKey = question.key;
    switch (question.id) {
        case "radius":
            return (
                <RadiusQuestionComponent
                    data={question.data}
                    questionKey={questionKey}
                    sub={sub}
                />
            );
        case "thermometer":
            return (
                <ThermometerQuestionComponent
                    data={question.data}
                    questionKey={questionKey}
                    sub={sub}
                />
            );
        case "tentacles":
            return (
                <TentacleQuestionComponent
                    data={question.data}
                    questionKey={questionKey}
                    sub={sub}
                />
            );
        case "matching":
            return (
                <MatchingQuestionComponent
                    data={question.data}
                    questionKey={questionKey}
                    sub={sub}
                />
            );
        case "measuring":
            return (
                <MeasuringQuestionComponent
                    data={question.data}
                    questionKey={questionKey}
                    sub={sub}
                />
            );
        case "zone-size":
            return (
                <ZoneSizeComponent
                    data={question.data}
                    questionKey={questionKey}
                />
            );
        default:
            return null;
    }
};
