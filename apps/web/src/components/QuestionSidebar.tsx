import { useStore } from "@nanostores/react";
import { SidebarCloseIcon } from "lucide-react";
import { useRef, useState } from "react";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { sidebarContextL as SidebarContext } from "@/lib/context";
import {
    autoSave,
    isLoading,
    questions,
    save,
    triggerLocalRefresh,
    warningAlarm,
} from "@/lib/context";

import { AddQuestionDialog } from "./AddQuestionDialog";
import {
    MatchingQuestionComponent,
    MeasuringQuestionComponent,
    RadiusQuestionComponent,
    TentacleQuestionComponent,
    ThermometerQuestionComponent,
} from "./QuestionCards";

export const QuestionSidebar = () => {
    useStore(triggerLocalRefresh);
    const $questions = useStore(questions);
    const $autoSave = useStore(autoSave);
    const $isLoading = useStore(isLoading);
    const $warningAlarm = useStore(warningAlarm);
    const [alarmActive, setAlarmActive] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    const startAlarm = () => {
        if (!$warningAlarm) return;
        setAlarmActive(true);
        const audio = new Audio("/Mountain%20Audio%20-%20Alarm.mp3");
        audio.loop = true;
        audio.play().catch(() => {});
        audioRef.current = audio;
    };

    const stopAlarm = () => {
        setAlarmActive(false);
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
            audioRef.current = null;
        }
    };

    return (
        <>
        {alarmActive && (
            <div className="warning-flash fixed inset-0 z-[1039] pointer-events-none" />
        )}
        <Sidebar>
            <div className="flex items-center justify-between">
                <h2 className="ml-4 mt-4 font-poppins text-2xl">Questions</h2>
                <SidebarCloseIcon
                    className="mr-2 visible md:hidden"
                    onClick={() => {
                        SidebarContext.get().setOpenMobile(false);
                    }}
                />
            </div>
            <SidebarContent>
                {$questions.map((question) => {
                    switch (question.id) {
                        case "radius":
                            return (
                                <RadiusQuestionComponent
                                    data={question.data}
                                    key={question.key}
                                    questionKey={question.key}
                                />
                            );
                        case "thermometer":
                            return (
                                <ThermometerQuestionComponent
                                    data={question.data}
                                    key={question.key}
                                    questionKey={question.key}
                                />
                            );
                        case "tentacles":
                            return (
                                <TentacleQuestionComponent
                                    data={question.data}
                                    key={question.key}
                                    questionKey={question.key}
                                />
                            );
                        case "matching":
                            return (
                                <MatchingQuestionComponent
                                    data={question.data}
                                    key={question.key}
                                    questionKey={question.key}
                                />
                            );
                        case "measuring":
                            return (
                                <MeasuringQuestionComponent
                                    data={question.data}
                                    key={question.key}
                                    questionKey={question.key}
                                />
                            );
                        default:
                            return null;
                    }
                })}
            </SidebarContent>
            <SidebarGroup>
                <SidebarGroupContent>
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <AddQuestionDialog>
                                <SidebarMenuButton disabled={$isLoading}>
                                    Add Question
                                </SidebarMenuButton>
                            </AddQuestionDialog>
                        </SidebarMenuItem>
                        <SidebarMenuItem>
                            <AlertDialog onOpenChange={(open) => open ? startAlarm() : stopAlarm()}>
                                <AlertDialogTrigger asChild>
                                    <SidebarMenuButton
                                        className="bg-red-600 hover:bg-red-700 transition-colors"
                                        disabled={$isLoading}
                                    >
                                        Delete All Questions
                                    </SidebarMenuButton>
                                </AlertDialogTrigger>
                                <AlertDialogContent aria-describedby={undefined}>
                                    <AlertDialogHeader>
                                        <AlertDialogTitle>
                                            Are you absolutely sure?
                                        </AlertDialogTitle>
                                        <AlertDialogDescription>
                                            This action cannot be undone. This
                                            will permanently delete all
                                            questions.
                                        </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                        <AlertDialogCancel>
                                            Cancel
                                        </AlertDialogCancel>
                                        <AlertDialogAction
                                            onClick={() => questions.set([])}
                                        >
                                            Delete All Questions
                                        </AlertDialogAction>
                                    </AlertDialogFooter>
                                </AlertDialogContent>
                            </AlertDialog>
                        </SidebarMenuItem>
                        {!$autoSave && (
                            <SidebarMenuItem>
                                <SidebarMenuButton
                                    className="bg-blue-600 p-2 rounded-md font-semibold font-poppins transition-shadow duration-500"
                                    onClick={save}
                                    disabled={$isLoading}
                                >
                                    Save
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        )}
                    </SidebarMenu>
                </SidebarGroupContent>
            </SidebarGroup>
        </Sidebar>
        </>
    );
};
