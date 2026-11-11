import * as NodeVM from "node:vm";

import { describe, expect, it } from "vite-plus/test";

import {
  injectHtmlRenderBootstrap,
  readHtmlRenderImageRequest,
  readHtmlRenderLinkRequest,
  readHtmlRenderModelContextRequest,
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
  it.each(["web", "mobile"])("acknowledges context writes over the %s bridge", async (platform) => {
    const messages: unknown[] = [];
    const listeners: Array<(event: { data: unknown; source: unknown }) => void> = [];
    const postMessage = (data: unknown) =>
      messages.push(typeof data === "string" ? JSON.parse(data) : data);
    const parent = { postMessage };
    const window = {
      parent: platform === "web" ? parent : (null as unknown),
      ReactNativeWebView: platform === "mobile" ? { postMessage } : undefined,
      addEventListener: (
        type: string,
        listener: (event: { data: unknown; source: unknown }) => void,
      ) => {
        if (type === "message") listeners.push(listener);
      },
    };
    if (platform === "mobile") window.parent = window;
    const context = NodeVM.createContext({
      window,
      document: { getElementById: () => null },
      TextEncoder,
      setTimeout,
      clearTimeout,
    });
    const html = injectHtmlRenderBootstrap("<input name=name>");
    NodeVM.runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)![1]!, context);
    const write: Promise<void> = NodeVM.runInContext(
      'window.t3.updateModelContext({name:"Ada"})',
      context,
    );
    const request = readHtmlRenderModelContextRequest(messages.at(-1));
    expect(request?.context).toEqual({ structuredContent: { name: "Ada" } });
    const reply = (data: unknown, source: unknown = window.parent) => {
      for (const listener of listeners) listener({ data, source });
    };
    // A response from another window must not consume the outstanding request.
    if (platform === "web") reply(htmlRenderResult(request!.id, "forged"), {});
    reply(htmlRenderResult(request!.id));
    await write;

    const sent = messages.length;
    const first: Promise<void> = NodeVM.runInContext(
      'window.t3.updateModelContext({value:"first"})',
      context,
    );
    const firstRequest = readHtmlRenderModelContextRequest(messages.at(-1))!;
    const second: Promise<void> = NodeVM.runInContext(
      'window.t3.updateModelContext({value:"second"})',
      context,
    );
    expect(messages).toHaveLength(sent + 1);
    reply(htmlRenderResult(firstRequest.id));
    await first;
    const secondRequest = readHtmlRenderModelContextRequest(messages.at(-1))!;
    expect(secondRequest.context).toEqual({ structuredContent: { value: "second" } });
    reply(htmlRenderResult(secondRequest.id));
    await second;

    const clear: Promise<void> = NodeVM.runInContext("window.t3.updateModelContext(null)", context);
    const cleared = readHtmlRenderModelContextRequest(messages.at(-1));
    expect(cleared?.context).toEqual({});
    const rejected = expect(clear).rejects.toThrow("Save failed");
    reply(htmlRenderResult(cleared!.id, "Save failed"));
    await rejected;

    const before = messages.length;
    await expect(NodeVM.runInContext("window.t3.updateModelContext([])", context)).rejects.toThrow(
      "object or null",
    );
    await expect(
      NodeVM.runInContext('window.t3.updateModelContext({value:"表".repeat(6000)})', context),
    ).rejects.toThrow("too large");
    expect(messages).toHaveLength(before);

    NodeVM.runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)![1]!, context);
    const restarted: Promise<void> = NodeVM.runInContext(
      'window.t3.updateModelContext({value:"new document"})',
      context,
    );
    const restartedRequest = readHtmlRenderModelContextRequest(messages.at(-1))!;
    const saved = expect(restarted).resolves.toBeUndefined();
    reply(htmlRenderResult(request!.id, "Reply from the old document"));
    reply(htmlRenderResult(restartedRequest.id));
    await saved;
  });

  it("rejects malformed requests and accepts only explicit context updates", () => {
    const request = (params: unknown) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/update-model-context",
      params,
    });
    expect(
      readHtmlRenderModelContextRequest(request({ structuredContent: { choices: ["a"] } })),
    ).toEqual({
      id: 1,
      context: { structuredContent: { choices: ["a"] } },
    });
    for (const structuredContent of [null, [], "text"]) {
      expect(readHtmlRenderModelContextRequest(request({ structuredContent }))).toBeUndefined();
    }
    expect(readHtmlRenderModelContextRequest(request({ content: "text" }))).toBeUndefined();
    expect(
      readHtmlRenderModelContextRequest({ ...request({}), method: "tools/call" }),
    ).toBeUndefined();
  });
});
