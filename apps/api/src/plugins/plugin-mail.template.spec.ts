import { render } from "react-email";
import { describe, expect, it } from "vitest";

import type { MailTemplateContext } from "../mail/mail-template";
import { pluginMail } from "./plugin-mail.template";

/**
 * What a plugin can put into a message the cooperative signs for.
 *
 * Mail sent through the host goes out from the instance's own address and
 * passes its DKIM signature, which is the whole point of the permission: mail
 * from a housing cooperative's system has to be attributable to the
 * cooperative. It is also the whole of the risk, because a link or an image a
 * plugin chose is then one the association appears to have written to its own
 * residents.
 *
 * The body is therefore text, and the markup is the template's. Not a boundary
 * against a package that means harm - a bundle runs at full process privilege
 * and can open its own connection (ADR 0003) - but the case that actually
 * happens is a plugin interpolating a resident's own text into a body, and
 * that cannot become markup from here.
 */

const CONTEXT = {
  t: ((key: string) => key) as unknown as MailTemplateContext["t"],
  locale: "sv",
  brand: { associationName: "Brf Exempel", primaryColor: "#000000" },
  appUrl: "https://exempel.se",
  formatDate: (date: Date) => date.toISOString(),
  formatTime: (date: Date) => date.toISOString(),
} satisfies MailTemplateContext;

const renderBody = (text: string): Promise<string> =>
  render(
    pluginMail.body({ subject: "Hej", text, pluginId: "occupancy" }, CONTEXT),
  );

describe("a message a plugin sends", () => {
  it("escapes markup in the body rather than rendering it", async () => {
    // What a careless plugin passes: a resident's own text, echoed back into
    // a body by interpolation.
    const html = await renderBody(
      '<a href="https://phishing.example">Betala hyran har</a>',
    );

    expect(html).not.toContain('<a href="https://phishing.example"');
    expect(html).toContain("&lt;a href=");
  });

  it("does not let a plugin open an image the association would be tracked by", async () => {
    const html = await renderBody('<img src="https://tracker.example/x.gif">');

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("does not let a plugin close the template's own markup", async () => {
    const html = await renderBody("</div></body></html><script>alert(1)");

    expect(html).not.toContain("<script");
    // The template's own document is intact: one closing tag, at the end.
    expect(html.split("</html>")).toHaveLength(2);
  });

  it("still renders the plugin's paragraphs and names the plugin", async () => {
    // The other half: escaping is not a reason for the message to arrive
    // unreadable.
    const html = await renderBody("Forsta stycket.\n\nAndra stycket.");

    expect(html).toContain("Forsta stycket.");
    expect(html).toContain("Andra stycket.");
    expect(html).toContain("occupancy");
    expect(html).toContain("Brf Exempel");
  });
});
