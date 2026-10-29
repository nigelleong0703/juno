import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageResponse } from "./message";

const sample = "截至 2026 年 10 月 15 日，本周值得关注的两条 OpenAI 动态：\n• **欧洲扩张：**OpenAI 宣布在爱尔兰新增 200 个岗位。\n• **监管与安全争议：**10 月 14 日，美国 8 个州。";

describe("MessageResponse agent prose", () => {
  it("applies CJK bold and turns • lines into list items", () => {
    const html = renderToStaticMarkup(<MessageResponse mode="static">{sample}</MessageResponse>);
    expect(html).toContain('data-streamdown="strong">欧洲扩张：</span>OpenAI');
    expect(html).toContain('data-streamdown="strong">监管与安全争议：</span>10');
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).not.toContain("**");
  });

  it("keeps code spans literal and breaks single newlines", () => {
    const html = renderToStaticMarkup(<MessageResponse mode="static">{"Run `**a：**b`\nnext"}</MessageResponse>);
    expect(html).toContain("**a：**b");
    expect(html).toContain("<br");
  });
});
