import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

const REPO = path.resolve(process.cwd());
const SCREENSHOTS = path.join(REPO, "e2e", "screenshots", "gala");
const BASE_URL = process.env["GALA_E2E_BASE_URL"] ?? "http://localhost:3001";

test("Gala protects its console and saves an operator settings draft", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await rm(SCREENSHOTS, { recursive: true, force: true });
  await mkdir(SCREENSHOTS, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  // The public surface must introduce Gala before asking an operator to authenticate.
  await page.goto(BASE_URL);
  await expect(
    page.getByRole("heading", { name: /Your agent/i }),
  ).toBeVisible();
  const openGala = page.getByRole("link", { name: "Open your Gala" });
  await expect(openGala).toBeVisible();
  await expect(openGala).toHaveAttribute("data-slot", "button");
  const navbarSignIn = page.getByRole("link", { name: "Sign in" });
  await expect(navbarSignIn).toHaveAttribute("data-variant", "coral");
  await navbarSignIn.hover();
  await expect(navbarSignIn).toHaveCSS("background-color", "rgb(255, 107, 74)");
  await expect(navbarSignIn).toHaveCSS("border-top-width", "0px");
  await expect(page.getByRole("link", { name: "Gala.sh home" })).toBeVisible();
  await expect(page.getByTestId("hero-side-motif")).toBeVisible();
  await expect(page.getByTestId("active-run-progress")).toHaveAttribute(
    "aria-valuenow",
    "7",
  );
  const progressFill = page.getByTestId("active-run-progress-fill");
  await expect(progressFill).toHaveCSS("animation-name", "run-progress-fill");
  await progressFill.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  expect(
    await progressFill.evaluate((element) => {
      const track = element.parentElement;
      if (!track) return 0;
      return (
        element.getBoundingClientRect().width /
        track.getBoundingClientRect().width
      );
    }),
  ).toBeCloseTo(0.875, 2);
  await page.screenshot({
    path: path.join(SCREENSHOTS, "01-landing.png"),
    fullPage: true,
  });

  // The dashboard itself must enforce authentication rather than relying on hidden navigation.
  await page.goto(`${BASE_URL}/home`);
  await page.waitForURL(/\/sign-in\?returnTo=\/home$/);
  await expect(
    page.getByRole("heading", { name: /Gala is expecting you/i }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOTS, "02-protected-sign-in.png"),
    fullPage: true,
  });

  // A complete credential form is the final state before the server creates a session.
  await page.getByLabel("Email").fill("gala-e2e@example.com");
  await page.getByLabel("Password").fill("gala-e2e-password");
  await page.screenshot({
    path: path.join(SCREENSHOTS, "03-credentials-filled.png"),
    fullPage: true,
  });

  // Successful authentication must land on the server-protected operator console.
  const signIn = page.getByRole("button", { name: "Sign in" });
  await expect(signIn).toHaveAttribute("data-slot", "button");
  await signIn.click();
  await page.waitForURL(`${BASE_URL}/home`);
  await expect(
    page.getByRole("heading", { name: "Gala control room" }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOTS, "04-dashboard.png"),
    fullPage: true,
  });

  // Channel setup needs an explicit, reviewable step before its draft changes state.
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Channels", exact: true }),
  ).toHaveAttribute("data-slot", "button");
  const iMessage = page.getByTestId("channel-bluebubbles");
  await iMessage.getByRole("button", { name: "Configure" }).click();
  await expect(
    page.getByRole("dialog", { name: "Configure iMessage" }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOTS, "05-imessage-configuration.png"),
    fullPage: true,
  });

  // Saving a channel draft must close the sheet and visibly update that channel only.
  await page.getByRole("button", { name: "Save connection draft" }).click();
  await expect(
    page.getByRole("dialog", { name: "Configure iMessage" }),
  ).toBeHidden();
  await expect(iMessage.getByText("Draft ready")).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await page.screenshot({
    path: path.join(SCREENSHOTS, "06-channel-draft-saved.png"),
    fullPage: true,
  });

  // A newly introduced high-impact capability must remain a deliberate opt-in.
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  const historyPermission = page.getByTestId("permission-history");
  const historySwitch = historyPermission.getByRole("switch");
  await expect(historySwitch).toHaveAttribute("aria-checked", "false");
  await historySwitch.click();
  await expect(historySwitch).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.screenshot({
    path: path.join(SCREENSHOTS, "07-permission-enabled.png"),
    animations: "disabled",
    fullPage: true,
  });

  // Reloading proves the saved draft is durable for this browser rather than transient React state.
  await page.reload();
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  await expect(
    page.getByTestId("permission-history").getByRole("switch"),
  ).toHaveAttribute("aria-checked", "true");
  await page.screenshot({
    path: path.join(SCREENSHOTS, "08-draft-after-reload.png"),
    fullPage: true,
  });

  // Signing out must destroy the session and restore the route boundary.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${BASE_URL}/sign-in`);
  await page.goto(`${BASE_URL}/home`);
  await page.waitForURL(/\/sign-in\?returnTo=\/home$/);
  await page.screenshot({
    path: path.join(SCREENSHOTS, "09-signed-out.png"),
    fullPage: true,
  });
  expect(browserErrors).toEqual([]);
});

test("Gala stays usable on a phone-sized viewport", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await mkdir(SCREENSHOTS, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });

  // The marketing surface must preserve its hierarchy without horizontal clipping on a phone.
  await page.goto(BASE_URL);
  await expect(
    page.getByRole("heading", { name: /Your agent/i }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Gala.sh home" })).toBeVisible();
  await expect(page.getByTestId("hero-side-motif")).toBeHidden();
  await expect(page.getByTestId("active-run-progress")).toHaveAttribute(
    "aria-valuenow",
    "7",
  );
  const mobileProgressFill = page.getByTestId("active-run-progress-fill");
  await mobileProgressFill.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  expect(
    await mobileProgressFill.evaluate((element) => {
      const track = element.parentElement;
      if (!track) return 0;
      return (
        element.getBoundingClientRect().width /
        track.getBoundingClientRect().width
      );
    }),
  ).toBeCloseTo(0.875, 2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: path.join(SCREENSHOTS, "10-mobile-landing.png"),
    fullPage: true,
  });

  // Dense card details must stay legible and contained as each card reaches the front.
  const mobileStack = page.getByTestId("hero-card-stack");
  const mobileShuffle = page.getByTestId("hero-card-shuffle");
  await mobileShuffle.click();
  await expect(page.getByTestId("hero-card-working")).toHaveAttribute(
    "data-slot-index",
    "2",
  );
  await page
    .getByTestId("hero-card-working")
    .locator(".working-context-bar-3")
    .evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
  await mobileStack.screenshot({
    path: path.join(SCREENSHOTS, "10b-mobile-working-card.png"),
  });

  await mobileShuffle.click();
  await expect(page.getByTestId("hero-card-incoming")).toHaveAttribute(
    "data-slot-index",
    "2",
  );
  await page
    .getByTestId("hero-card-incoming")
    .locator(".incoming-check-3")
    .evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
  await mobileStack.screenshot({
    path: path.join(SCREENSHOTS, "10c-mobile-incoming-card.png"),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  // A mobile operator needs the same authenticated console and an explicit way to end the session.
  await page.goto(`${BASE_URL}/home`);
  await page.getByLabel("Email").fill("gala-e2e@example.com");
  await page.getByLabel("Password").fill("gala-e2e-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${BASE_URL}/home`);
  await expect(
    page.getByRole("heading", { name: "Gala control room" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: path.join(SCREENSHOTS, "11-mobile-dashboard.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${BASE_URL}/sign-in`);
  expect(browserErrors).toEqual([]);
});

test("the hero card stack shuffles every card through the front", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await mkdir(SCREENSHOTS, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(BASE_URL);

  const stack = page.getByTestId("hero-card-stack");
  const shuffle = page.getByTestId("hero-card-shuffle");
  const active = page.getByTestId("hero-card-active");
  const working = page.getByTestId("hero-card-working");
  const incoming = page.getByTestId("hero-card-incoming");
  const progressFill = page.getByTestId("active-run-progress-fill");
  const workingBar = page.getByTestId("working-context-bar");
  const incomingRoute = page.getByTestId("incoming-route-fill");

  // The detailed active-run card begins on top; animations on rear cards stay dormant.
  await expect(active).toHaveAttribute("data-slot-index", "2");
  await expect(progressFill).toHaveCSS("animation-name", "run-progress-fill");
  await expect(workingBar).toHaveCSS("animation-name", "none");
  await expect(incomingRoute).toHaveCSS("animation-name", "none");
  await progressFill.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  await stack.screenshot({
    path: path.join(SCREENSHOTS, "12-card-stack-initial.png"),
  });

  // The outgoing card must visibly leave the stack before its order changes.
  await shuffle.click();
  await expect(stack).toHaveAttribute("data-shuffling", "true");
  await page.waitForFunction(() => {
    const card = document.querySelector<HTMLElement>(
      '[data-testid="hero-card-active"]',
    );
    const currentTime = card?.getAnimations()[0]?.currentTime;
    return typeof currentTime === "number" && currentTime >= 300;
  });
  await stack.screenshot({
    path: path.join(SCREENSHOTS, "13-card-stack-active-sliding-off.png"),
  });

  // Working context animates only once it becomes the front card; active run is now idle.
  await expect(active).toHaveAttribute("data-slot-index", "0");
  await expect(working).toHaveAttribute("data-slot-index", "2");
  await expect(progressFill).toHaveCSS("animation-name", "none");
  await expect(workingBar).toHaveCSS(
    "animation-name",
    "working-context-bar-in",
  );
  await expect(incomingRoute).toHaveCSS("animation-name", "none");
  await page.waitForFunction(() => {
    const card = document.querySelector<HTMLElement>(
      '[data-testid="hero-card-working"]',
    );
    const rotateTransition = card
      ?.getAnimations()
      .find(
        (animation) =>
          animation instanceof CSSTransition &&
          animation.transitionProperty === "rotate",
      );
    const currentTime = rotateTransition?.currentTime;
    return (
      rotateTransition?.playState === "running" &&
      typeof currentTime === "number" &&
      currentTime > 40 &&
      currentTime < 350
    );
  });
  await expect(stack).toHaveAttribute("data-stack-phase", "idle");
  await stack.screenshot({
    path: path.join(SCREENSHOTS, "14-card-stack-working-hover-transition.png"),
  });
  await working.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished),
    );
  });
  await expect(working).toHaveCSS("rotate", "0.7deg");
  await working.locator(".working-context-bar-3").evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  await stack.screenshot({
    path: path.join(SCREENSHOTS, "14b-card-stack-working-front.png"),
  });

  // Incoming request runs its routing checks only after the second shuffle puts it on top.
  await shuffle.click();
  await expect(incoming).toHaveAttribute("data-slot-index", "2");
  await expect(progressFill).toHaveCSS("animation-name", "none");
  await expect(workingBar).toHaveCSS("animation-name", "none");
  await expect(incomingRoute).toHaveCSS(
    "animation-name",
    "incoming-route-fill",
  );
  await incoming.locator(".incoming-check-3").evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  await stack.screenshot({
    path: path.join(SCREENSHOTS, "15-card-stack-incoming-front.png"),
  });

  // A keyboard shuffle without hover must settle neutrally rather than inventing motion.
  await page.mouse.move(8, 8);
  expect(await stack.evaluate((element) => element.matches(":hover"))).toBe(
    false,
  );
  await shuffle.focus();
  await page.keyboard.press("Enter");
  await expect(active).toHaveAttribute("data-slot-index", "2");
  await expect(stack).toHaveAttribute("data-stack-phase", "idle");
  expect(
    await active.evaluate(
      (element) =>
        element
          .getAnimations()
          .filter((animation) => animation instanceof CSSTransition).length,
    ),
  ).toBe(0);
  await expect(progressFill).toHaveCSS("animation-name", "run-progress-fill");
  await expect(workingBar).toHaveCSS("animation-name", "none");
  await expect(incomingRoute).toHaveCSS("animation-name", "none");
  await expect(shuffle).toHaveAttribute(
    "aria-label",
    "Shuffle cards. Currently showing Active run.",
  );
  await progressFill.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  await stack.screenshot({
    path: path.join(SCREENSHOTS, "16-card-stack-cycle-complete.png"),
  });
  expect(browserErrors).toEqual([]);
});
