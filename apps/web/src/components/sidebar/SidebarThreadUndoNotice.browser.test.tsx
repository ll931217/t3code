import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";

describe("SidebarThreadUndoNotice", () => {
  it("unmounts at once when effects are reduced, since no transition ends", async () => {
    using _reduced = vi
      .spyOn(window, "matchMedia")
      .mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} } as never);
    useThreadUndoNotice.setState({
      notice: { action: "Archived", count: 1, undo: async () => {} },
    });
    await using screen = await render(<SidebarThreadUndoNotice />, { router: false });
    await expect.element(screen.getByText("Archived,")).toBeInTheDocument();

    useThreadUndoNotice.setState({ notice: null });
    await vi.waitFor(() => expect(screen.container.textContent).toBe(""));
  });
});
