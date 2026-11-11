import * as NodeVM from "node:vm";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  injectHtmlRenderBootstrap,
  readHtmlRenderImageRequest,
  readHtmlRenderLinkRequest,
  handleHtmlRenderModelContextRequest,
  htmlRenderModelContextReady,
  HTML_RENDER_CONTEXT_READY,
  htmlRenderResult,
} from "./htmlRender.ts";
import { htmlRenderFromToolItem } from "./toolOutput.ts";

const reference = { attachmentId: "thread-abc-123.html", title: "Chart", height: 420 };

describe("injectHtmlRenderBootstrap", () => {
  it("puts the theme ahead of the page's own head content", () => {
    const html =
      "<!doctype html><html><head><style>:root{--background:red}</style></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    const themeAt = injected.indexOf('<style id="t3-theme">');
    expect(themeAt).toBeGreaterThan(injected.indexOf("<head>"));
    expect(themeAt).toBeLessThan(injected.indexOf(":root{--background:red}"));
    expect(injected).toContain('<meta charset="utf-8">');
    expect(injected).toContain('name="viewport"');
  });

  it("wraps fragments without a head and keeps existing meta tags", () => {
    const fragment =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>hi</p>';
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.match(/charset/g)).toHaveLength(1);
    expect(injected.match(/name="viewport"/g)).toHaveLength(1);
    expect(injected.endsWith("<p>hi</p>")).toBe(true);
  });

  it.each(["textarea", "iframe", "plaintext"])("keeps the bootstrap outside %s content", (tag) => {
    const fragment = `<${tag}><head><meta name="viewport"></head></${tag}>`;
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf(`<${tag}>`));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it.each([
    '<template><head><meta name="viewport"></head></template>',
    '<template><template>inner</template><head><meta name="viewport"></head></template>',
  ])("keeps the bootstrap outside inert template content: %s", (fragment) => {
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf("<template>"));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it("ignores tags written inside comments and scripts", () => {
    const html =
      '<!-- copy <head> and <meta name="viewport"> here --><html><head>' +
      "<script>const tag = '<meta name=\"viewport\">';</script></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    expect(injected.indexOf('<style id="t3-theme">')).toBeGreaterThan(
      injected.indexOf("<html><head>"),
    );
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
  });
});

describe("readHtmlRenderLinkRequest", () => {
  it("accepts only http(s) URLs in an MCP Apps ui/open-link request", () => {
    const link = (url: unknown, modifiers = {}) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url, ...modifiers },
    });
    expect(readHtmlRenderLinkRequest(link("https://example.com/a"))).toEqual({
      id: 1,
      url: "https://example.com/a",
      metaKey: false,
      ctrlKey: false,
    });
    expect(
      readHtmlRenderLinkRequest(link("https://example.com/a", { metaKey: true, ctrlKey: "yes" })),
    ).toEqual({ id: 1, url: "https://example.com/a", metaKey: true, ctrlKey: false });
    expect(readHtmlRenderLinkRequest(link("javascript:alert(1)"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link("file:///etc/passwd"))).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({
        jsonrpc: "2.0",
        method: "ui/open-link",
        params: { url: "https://example.com" },
      }),
    ).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({ type: "t3-html-render-link", url: "https://example.com" }),
    ).toBeUndefined();
  });
});

describe("readHtmlRenderImageRequest", () => {
  it("accepts http(s) and inline image URLs in an open-image notification", () => {
    const image = (params: unknown) => ({
      jsonrpc: "2.0",
      method: "t3/notifications/open-image",
      params,
    });
    expect(
      readHtmlRenderImageRequest(image({ src: "data:image/png;base64,AA", name: " Chart " })),
    ).toEqual({
      src: "data:image/png;base64,AA",
      name: "Chart",
    });
    expect(readHtmlRenderImageRequest(image({ src: "https://example.com/a.png" }))).toEqual({
      src: "https://example.com/a.png",
      name: "Image",
    });
    expect(readHtmlRenderImageRequest(image({ src: "javascript:alert(1)" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "data:text/html,<p>" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "blob:null/1" }))).toBeUndefined();
  });
});

describe("htmlRenderFromToolItem", () => {
  const result = { htmlRender: reference, message: "Rendered above your reply." };

  it("reads the reference from each provider's result envelope", () => {
    for (const [toolName, output] of [
      ["mcp__t3-code__html_render", [{ type: "text", text: JSON.stringify(result) }]],
      ["t3-code.html_render", { structuredContent: result, content: [] }],
      ["t3-code-thread_1_html_render", JSON.stringify(result)],
      ["html_render", result],
    ] as const) {
      expect(htmlRenderFromToolItem({ toolName, output })).toEqual(reference);
    }
  });
});

describe("HTML render model context", () => {
  it.each(["web", "mobile"])(
    "orders writes over %s and ignores stale replies",
    async (platform) => {
      const messages: unknown[] = [];
      let receive!: (event: { data: unknown; source: unknown }) => void;
      const window = {
        parent: {} as unknown,
        t3: {} as { updateModelContext: (state: unknown) => Promise<void> },
        ReactNativeWebView:
          platform === "mobile"
            ? { postMessage: (data: string) => messages.push(data) }
            : undefined,
        addEventListener: (type: string, listener: typeof receive) => {
          if (type === "message") receive = listener;
        },
      };
      window.parent =
        platform === "web" ? { postMessage: (data: unknown) => messages.push(data) } : window;
      const script = /<script>([\s\S]*?)<\/script>/.exec(injectHtmlRenderBootstrap("<input>"))![1]!;
      const boot = () =>
        NodeVM.runInNewContext(script, {
          window,
          document: { getElementById: () => null },
          TextEncoder,
          setTimeout,
        });
      boot();
      const update = vi.fn(async (_state: unknown) => true);
      const reply = vi.fn((data: unknown) => receive({ data, source: window.parent }));
      const token = platform === "mobile" ? "host-token" : undefined;
      const initialize = (source: unknown = window) =>
        receive({ data: htmlRenderModelContextReady("host-token"), source });
      const respond = () =>
        handleHtmlRenderModelContextRequest(messages.at(-1), update, reply, token);
      const sent = messages.length;
      const first = window.t3.updateModelContext({ value: "first" });
      const state = { value: "second" };
      const second = window.t3.updateModelContext(state);
      state.value = "changed after enqueue";
      if (platform === "mobile") {
        expect(messages.at(-1)).toBe(HTML_RENDER_CONTEXT_READY);
        expect(messages).toHaveLength(sent);
        initialize({});
        expect(messages).toHaveLength(sent);
        initialize();
      }
      expect(messages).toHaveLength(sent + 1);
      update.mockResolvedValueOnce(false);
      reply.mockImplementationOnce((data) => receive({ data, source: {} }));
      await respond();
      await respond();
      await first;
      await respond();
      await second;
      expect(update.mock.calls.slice(-2)).toEqual([
        [{ structuredContent: { value: "first" } }],
        [{ structuredContent: { value: "second" } }],
      ]);
      const oldId = (reply.mock.calls[0]![0] as { id: string }).id;
      update.mockResolvedValueOnce(false);
      const clear = window.t3.updateModelContext(null);
      const rejected = expect(clear).rejects.toThrow("Context could not be saved");
      await respond();
      expect(update).toHaveBeenLastCalledWith({});
      await rejected;
      for (const state of [[], { value: "表".repeat(6000) }])
        await expect(window.t3.updateModelContext(state)).rejects.toThrow();
      boot();
      if (platform === "mobile") initialize();
      const restarted = window.t3.updateModelContext({ value: "new document" });
      reply(htmlRenderResult(oldId, "Reply from the old document"));
      await respond();
      await expect(restarted).resolves.toBeUndefined();
    },
  );

  it("refuses native context updates without the main frame's host token", async () => {
    const update = vi.fn(async () => true);
    const reply = vi.fn();
    const request = {
      jsonrpc: "2.0",
      id: "child",
      method: "ui/update-model-context",
      params: { structuredContent: { note: "untrusted iframe" } },
    };
    for (const token of [undefined, "guessed-token"])
      await handleHtmlRenderModelContextRequest(
        JSON.stringify({ ...request, t3ContextToken: token }),
        update,
        reply,
        "host-token",
      );
    expect(update).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    await handleHtmlRenderModelContextRequest(
      JSON.stringify({ ...request, t3ContextToken: "host-token" }),
      update,
      reply,
      "host-token",
    );
    expect(update).toHaveBeenCalledExactlyOnceWith(request.params);
  });

  it("ignores malformed or unsupported messages without updating context", async () => {
    const update = vi.fn(async () => true);
    const reply = vi.fn();
    const request = (params: unknown) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/update-model-context",
      params,
    });
    for (const message of [
      null,
      "{",
      {},
      request(null),
      request({ content: [] }),
      ...[null, [], "text"].map((structuredContent) => request({ structuredContent })),
      { ...request({}), id: undefined },
      { ...request({}), method: "tools/call" },
    ])
      await handleHtmlRenderModelContextRequest(message, update, reply);
    expect(update).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});
