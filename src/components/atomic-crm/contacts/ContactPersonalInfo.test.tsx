import { ResourceContextProvider, ShowBase } from "ra-core";
import { render } from "vitest-browser-react";
import { buildContact, StoryWrapper } from "@/test/StoryWrapper";
import { ContactAside } from "./ContactAside";

describe("ContactPersonalInfo", () => {
  it("renders the phone number as a clickable tel: link with its type", async () => {
    const contact = buildContact({
      email_jsonb: [],
      phone_jsonb: [{ number: "+1 555-123-4567", type: "Work" }],
    });

    const screen = await render(
      <StoryWrapper data={{ contacts: [contact] }}>
        <ResourceContextProvider value="contacts">
          <ShowBase id={contact.id}>
            <ContactAside />
          </ShowBase>
        </ResourceContextProvider>
      </StoryWrapper>,
    );

    const phoneLink = screen.getByRole("link", { name: "+1 555-123-4567" });
    await expect.element(phoneLink).toBeVisible();
    await expect
      .element(phoneLink)
      .toHaveAttribute("href", "tel:+1 555-123-4567");
    await expect.element(screen.getByText("Work")).toBeVisible();
  });

  it("copies the phone number to the clipboard and shows a checkmark when the icon is clicked", async () => {
    const contact = buildContact({
      email_jsonb: [],
      phone_jsonb: [{ number: "+1 555-123-4567", type: "Work" }],
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const screen = await render(
      <StoryWrapper data={{ contacts: [contact] }}>
        <ResourceContextProvider value="contacts">
          <ShowBase id={contact.id}>
            <ContactAside />
          </ShowBase>
        </ResourceContextProvider>
      </StoryWrapper>,
    );

    const copyButton = screen.getByRole("button", { name: "Copy" });
    await copyButton.click();

    await expect
      .poll(() => writeText.mock.calls)
      .toEqual([["+1 555-123-4567"]]);
    await expect
      .poll(() => copyButton.query()?.querySelector(".lucide-check") != null)
      .toBe(true);
  });
});
