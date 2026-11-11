import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, userEvent } from "vite-plus/test/browser";

import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";

import "~/index.css";
import { render } from "../../../test/render";

const fixture = vi.hoisted(() => ({
  url: "about:blank",
  update: vi.fn(async (_input: unknown) => ({ _tag: "Success" as const, value: undefined })),
}));

vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => fixture.update }));

vi.mock(import("~/assets/longLivedAssetUrls"), () => ({
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    url: fixture.url,
    expiresAt: Date.now() + 60 * 60_000,
  }),
}));
vi.mock(import("~/assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrlRefresh: () => async () => "about:blank",
}));

import { HtmlRenderFrame } from "./HtmlRenderFrame";

function setup() {
  fixture.url = "about:blank";
  fixture.update.mockClear();
}

describe("HtmlRenderFrame", () => {
  it("reports leaving full screen when it unmounts while expanded", async () => {
    setup();
    const onFullscreenChange = vi.fn();
    await using screen = await render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        htmlRender={{ attachmentId: "attachment", title: "Report", height: 200 }}
        threadRef={undefined}
        onFullscreenChange={onFullscreenChange}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Open full screen" }));
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    expect(onFullscreenChange).toHaveBeenLastCalledWith(true);

    await screen.unmount();
    expect(onFullscreenChange).toHaveBeenLastCalledWith(false);
  });

  it("publishes a generated form's input to its conversation and acknowledges saving", async () => {
    setup();
    const html =
      injectHtmlRenderBootstrap(`<form><input name="name"><button>Save</button><output></output></form>
      <script>document.querySelector('form').onsubmit = async e => {
        e.preventDefault();
        await window.t3.updateModelContext({name: document.querySelector('input').value});
        document.querySelector('output').textContent = 'Saved';
      };</script>`);
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(url) };
    fixture.url = url;
    const target = {
      environmentId: EnvironmentId.make("environment"),
      input: {
        threadId: ThreadId.make("source"),
        itemId: TurnItemId.make("form"),
        conversationThreadId: ThreadId.make("fork"),
      },
    };
    await using screen = await render(
      <HtmlRenderFrame
        environmentId={target.environmentId}
        htmlRender={{ attachmentId: "form-html", title: "Form", height: 160 }}
        threadRef={undefined}
        modelContextTarget={target}
      />,
    );
    const frame = screen.getByTitle("Form").element() as HTMLIFrameElement;
    await vi.waitFor(() => expect(frame.contentWindow).not.toBeNull());
    const session = cdp();
    const child = await vi.waitFor(async () => {
      const { frameTree } = await session.send("Page.getFrameTree");
      const find = (tree: typeof frameTree): typeof frameTree | undefined =>
        tree.frame.url.startsWith(url) ? tree : tree.childFrames?.map(find).find(Boolean);
      const found = find(frameTree);
      expect(found).toBeDefined();
      return found!;
    });
    const { executionContextId } = await session.send("Page.createIsolatedWorld", {
      frameId: child!.frame.id,
      worldName: "form-test",
    });
    await session.send("Runtime.evaluate", {
      contextId: executionContextId,
      expression: `document.querySelector('input').value = 'Ada'; document.querySelector('form').requestSubmit();`,
    });
    await vi.waitFor(() =>
      expect(fixture.update).toHaveBeenCalledWith({
        ...target,
        input: { ...target.input, structuredContent: { name: "Ada" } },
      }),
    );
    await vi.waitFor(async () => {
      const result = await session.send("Runtime.evaluate", {
        contextId: executionContextId,
        expression: "document.querySelector('output').textContent",
        returnByValue: true,
      });
      expect(result.result.value).toBe("Saved");
    });
  });
});
