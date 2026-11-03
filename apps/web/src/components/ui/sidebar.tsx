import { useStore } from "@nanostores/react";
import * as React from "react";
import { LiaThumbtackSolid } from "react-icons/lia";
import { TbMessage2Question } from "react-icons/tb";

import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { sidebarContextL, sidebarContextR } from "@/lib/context";
import { cn } from "@/lib/utils";

// The map page has two sidebars: questions on the left, hiding zones on the
// right. Each side keeps its open state in its own atom.
type Side = "left" | "right";
const contextOf = (side: Side) =>
    side === "left" ? sidebarContextL : sidebarContextR;

const SIDEBAR_WIDTH = "16rem";
const SIDEBAR_WIDTH_MOBILE = "18rem";
const SIDEBAR_KEYBOARD_SHORTCUT = "b";
export const MENU_ITEM_CLASSNAME =
    "flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0";

const SidebarProvider = ({
    side,
    defaultOpen = true,
    children,
}: {
    side: Side;
    defaultOpen?: boolean;
    children?: React.ReactNode;
}) => {
    const SidebarContext = contextOf(side);
    const isMobile = useIsMobile();
    const [openMobile, setOpenMobile] = React.useState(false);
    const [open, setOpen] = React.useState(defaultOpen);

    const toggleSidebar = React.useCallback(() => {
        if (isMobile) setOpenMobile((o) => !o);
        else setOpen((o) => !o);
    }, [isMobile]);

    // Adds a keyboard shortcut to toggle the sidebar.
    React.useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (
                event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
                (event.metaKey || event.ctrlKey)
            ) {
                event.preventDefault();
                toggleSidebar();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [toggleSidebar]);

    React.useEffect(() => {
        SidebarContext.set({
            state: open ? "expanded" : "collapsed",
            open,
            setOpen,
            isMobile,
            openMobile,
            setOpenMobile,
            toggleSidebar,
        });
    }, [SidebarContext, open, isMobile, openMobile, toggleSidebar]);

    return (
        <div
            style={{ "--sidebar-width": SIDEBAR_WIDTH } as React.CSSProperties}
            className="group/sidebar-wrapper flex min-h-svh w-full"
        >
            {children}
        </div>
    );
};

const Sidebar = ({
    side = "left",
    children,
}: {
    side?: Side;
    children?: React.ReactNode;
}) => {
    const { isMobile, state, openMobile, setOpenMobile } = useStore(
        contextOf(side),
    );

    if (isMobile) {
        return (
            <Sheet open={openMobile} onOpenChange={setOpenMobile}>
                <SheetContent
                    data-sidebar="sidebar"
                    data-mobile="true"
                    className="w-full bg-sidebar p-0 text-sidebar-foreground z-[1035]"
                    style={
                        {
                            "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
                        } as React.CSSProperties
                    }
                    side={side}
                    // Tapping a toast (Undo after a delete) keeps the
                    // sidebar open.
                    onInteractOutside={(e) => {
                        if (
                            (e.target as Element | null)?.closest?.(
                                ".Toastify",
                            )
                        )
                            e.preventDefault();
                    }}
                >
                    <div className="flex h-full w-full flex-col">
                        {children}
                    </div>
                </SheetContent>
            </Sheet>
        );
    }

    return (
        <div
            className="group peer hidden md:block text-sidebar-foreground"
            data-state={state}
            data-collapsible={state === "collapsed" ? "offcanvas" : ""}
            data-side={side}
        >
            {/* This is what handles the sidebar gap on desktop */}
            <div
                className={cn(
                    "duration-200 relative h-svh w-[--sidebar-width] bg-transparent transition-[width] ease-linear",
                    "group-data-[collapsible=offcanvas]:w-0",
                    "group-data-[side=right]:rotate-180",
                )}
            />
            <div
                className={cn(
                    "duration-200 fixed inset-y-0 z-10 hidden h-svh w-[--sidebar-width] transition-[left,right,width] ease-linear md:flex",
                    side === "left"
                        ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"
                        : "right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]",
                    "group-data-[side=left]:border-r group-data-[side=right]:border-l",
                )}
            >
                <div
                    data-sidebar="sidebar"
                    className="flex h-full w-full flex-col bg-sidebar"
                >
                    {children}
                </div>
            </div>
        </div>
    );
};

const SidebarTrigger = ({ side }: { side: Side }) => {
    const { toggleSidebar } = useStore(contextOf(side));

    return (
        <button
            data-sidebar="trigger"
            className={cn(
                "bg-white hover:bg-[#f4f4f4] text-black rounded-sm border-2 border-black border-opacity-30 cursor-pointer py-1 px-2",
                "flex items-center gap-1",
            )}
            onClick={toggleSidebar}
        >
            {side === "left" ? <TbMessage2Question /> : <LiaThumbtackSolid />}
        </button>
    );
};

const SidebarContent = React.forwardRef<
    HTMLDivElement,
    React.ComponentProps<"div">
>(({ className, ...props }, ref) => {
    return (
        <div
            ref={ref}
            data-sidebar="content"
            className={cn(
                "flex min-h-0 flex-1 flex-col gap-2 overflow-auto",
                className,
            )}
            {...props}
        />
    );
});
SidebarContent.displayName = "SidebarContent";

const SidebarGroup = React.forwardRef<
    HTMLDivElement,
    React.ComponentProps<"div">
>(({ className, ...props }, ref) => {
    return (
        <div
            ref={ref}
            data-sidebar="group"
            className={cn(
                "relative flex w-full min-w-0 flex-col p-2",
                className,
            )}
            {...props}
        />
    );
});
SidebarGroup.displayName = "SidebarGroup";

const SidebarGroupLabel = React.forwardRef<
    HTMLDivElement,
    React.ComponentProps<"div">
>(({ className, ...props }, ref) => (
    <div
        ref={ref}
        data-sidebar="group-label"
        className={cn(
            "duration-200 flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-[margin,opa] ease-linear focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
            className,
        )}
        {...props}
    />
));
SidebarGroupLabel.displayName = "SidebarGroupLabel";

const SidebarGroupContent = React.forwardRef<
    HTMLDivElement,
    React.ComponentProps<"div">
>(({ className, ...props }, ref) => (
    <div
        ref={ref}
        data-sidebar="group-content"
        className={cn("w-full text-sm", className)}
        {...props}
    />
));
SidebarGroupContent.displayName = "SidebarGroupContent";

const SidebarMenu = React.forwardRef<
    HTMLUListElement,
    React.ComponentProps<"ul">
>(({ className, ...props }, ref) => (
    <ul
        ref={ref}
        data-sidebar="menu"
        className={cn("flex w-full min-w-0 flex-col gap-1", className)}
        {...props}
    />
));
SidebarMenu.displayName = "SidebarMenu";

const SidebarMenuItem = React.forwardRef<
    HTMLLIElement,
    React.ComponentProps<"li"> & {
        disabled?: boolean;
    }
>(({ className, disabled, onClick, ...props }, ref) => (
    <li
        ref={ref}
        data-sidebar="menu-item"
        className={cn(
            "group/menu-item relative",
            disabled && "pointer-events-none opacity-50",
            className,
        )}
        onClick={disabled ? undefined : onClick}
        {...props}
    />
));
SidebarMenuItem.displayName = "SidebarMenuItem";

const SidebarMenuButton = React.forwardRef<
    HTMLButtonElement,
    React.ComponentProps<"button">
>(({ className, ...props }, ref) => (
    <button
        ref={ref}
        data-sidebar="menu-button"
        className={cn(MENU_ITEM_CLASSNAME, "h-8", className)}
        {...props}
    />
));
SidebarMenuButton.displayName = "SidebarMenuButton";

export {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
    SidebarTrigger,
};
