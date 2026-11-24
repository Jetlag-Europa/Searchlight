import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Capture what the wrapper hands Radix's root.
const root = vi.hoisted(() => ({
  onValueChange: undefined as ((value: string) => void) | undefined,
}));
vi.mock("@radix-ui/react-toggle-group", () => ({
  Root: (props: { onValueChange: (value: string) => void }) => {
    root.onValueChange = props.onValueChange;
    return null;
  },
  Item: () => null,
}));

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

describe("single toggle group", () => {
  it("keeps the pressed answer when it is tapped again", () => {
    const onValueChange = vi.fn();
    renderToStaticMarkup(
      <ToggleGroup type="single" value="inside" onValueChange={onValueChange}>
        <ToggleGroupItem value="outside">Outside</ToggleGroupItem>
        <ToggleGroupItem value="inside">Inside</ToggleGroupItem>
      </ToggleGroup>,
    );
    // Radix sends "" for a tap on the pressed item.
    root.onValueChange!("");
    expect(onValueChange).not.toHaveBeenCalled();
    root.onValueChange!("outside");
    expect(onValueChange).toHaveBeenCalledWith("outside");
  });
});
