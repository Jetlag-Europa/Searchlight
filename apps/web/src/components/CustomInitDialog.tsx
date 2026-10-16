import { useStore } from "@nanostores/react";
import * as React from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { customInitPreference } from "@/lib/context";

type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onBlank: () => void | Promise<void>;
    onPrefill: () => void | Promise<void>;
    checkboxId?: string;
};

export const CustomInitDialog: React.FC<Props> = ({
    open,
    onOpenChange,
    onBlank,
    onPrefill,
    checkboxId = "remember-custom-init",
}) => {
    useStore(customInitPreference);
    const [remember, setRemember] = useState(false);

    const handleBlank = async () => {
        if (remember) customInitPreference.set("blank");
        await onBlank();
    };
    const handlePrefill = async () => {
        if (remember) customInitPreference.set("prefill");
        await onPrefill();
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>New Custom Zone</DialogTitle>
                    <DialogDescription>
                        Do you want the zone to start blank, or as the
                        seeker&apos;s cell among the current custom points?
                    </DialogDescription>
                </DialogHeader>
                <div className="flex items-center gap-2">
                    <Checkbox
                        id={checkboxId}
                        checked={remember}
                        onCheckedChange={(c) => setRemember(Boolean(c))}
                    />
                    <label htmlFor={checkboxId} className="text-sm">
                        Remember my choice
                    </label>
                </div>
                <DialogFooter>
                    <Button variant="secondary" onClick={handleBlank}>
                        Start blank
                    </Button>
                    <Button onClick={handlePrefill}>Copy from current</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default CustomInitDialog;
