import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// vaul's drawer renders nothing while closed, so render the Options drawer's
// contents inline.
vi.mock("@/components/ui/drawer", () => {
  const Inline = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Drawer: Inline,
    DrawerContent: Inline,
    DrawerHeader: Inline,
    DrawerTitle: Inline,
    DrawerTrigger: Inline,
  };
});
// Every dialog in the drawer is closed, and DialogContent reads `document`
// as it renders.
vi.mock("@/components/ui/dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/dialog")>()),
  DialogContent: () => null,
}));

import { OptionDrawers } from "@/components/OptionDrawers";
import { autoSave, hiderMode, questionModified, save, unsavedChanges } from "@/lib/context";

const renderOptions = () => {
  const html = renderToStaticMarkup(<OptionDrawers />);
  return {
    // The hider location editor's latitude field.
    editor: html.includes('value="51.92"'),
    saveButtons: html.match(/>Save<\/button>/g)?.length ?? 0,
  };
};

describe("hider location Save button", () => {
  afterEach(() => {
    autoSave.set(true);
    hiderMode.set(false);
  });

  it("shows with auto-save off", () => {
    autoSave.set(false);
    hiderMode.set({ latitude: 51.92, longitude: 4.48 });
    expect(renderOptions()).toEqual({ editor: true, saveButtons: 1 });
  });

  it("hides with auto-save on, where edits apply at once", () => {
    hiderMode.set({ latitude: 51.92, longitude: 4.48 });
    expect(renderOptions()).toEqual({ editor: true, saveButtons: 0 });
  });

  it("hides outside hider mode", () => {
    autoSave.set(false);
    expect(renderOptions()).toEqual({ editor: false, saveButtons: 0 });
  });
});

describe("unsaved changes with auto-save off", () => {
  afterEach(() => autoSave.set(true));

  it("are marked by an edit and cleared by Save", () => {
    autoSave.set(false);
    questionModified();
    expect(unsavedChanges.get()).toBe(true);
    // A hider position (a teammate's, or Hider mode toggled) doesn't save the answers.
    hiderMode.set({ latitude: 52, longitude: 4 });
    expect(unsavedChanges.get()).toBe(true);
    save();
    expect(unsavedChanges.get()).toBe(false);
  });

  it("aren't marked with auto-save on", () => {
    questionModified();
    expect(unsavedChanges.get()).toBe(false);
  });
});
