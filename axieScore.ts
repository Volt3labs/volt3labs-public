#!/usr/bin/env node
import { setTimeout as wait } from "node:timers/promises";
import { addExtra } from "puppeteer-extra"
import core from "puppeteer-core"

export const puppeteer = addExtra(core)

//puppeteer.use(Stealth())

const execPath =
  process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/google-chrome" // or chromium

import { Page, Protocol } from "puppeteer"
type Cookie = Protocol.Network.Cookie
type RunResult = {
  address: string
  name: string | null
  axieScore: number
  title: string
} | null



// --- inputs ---
const ENDPOINT = "https://graphql-gateway.axieinfinity.com/graphql";

const QUERY = `
  query GetMiniProfileByRoninAddress(
    $address: String!
    $includeTotalAxies: Boolean!
    $includeTotalBadges: Boolean!
  ) {
    publicProfileWithRoninAddress(address: $address) {
      name
      settings {
        axieEcosystemStats {
          axieScore
          title
          __typename
        }
        __typename
      }
      __typename
    }
    axies(owner: $address, criteria: {stages: [4]}) @include(if: $includeTotalAxies) { total __typename }
    badges(ownerFilter: {obtained: true, unobtained: false, owner: $address}) @include(if: $includeTotalBadges) { total __typename }
  }
`;

async function ensureCloudflarePass(page: Page, targetURL: string) {
  // Hit the target host so Cloudflare can run its JS + set cookies
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "accept": "text/html,application/json;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
  });

  await page.goto(targetURL, { waitUntil: "domcontentloaded", timeout: 120000 });

  // Wait up to ~20s for Cloudflare cookies to appear for this domain
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const cookies = await page.cookies();
    const cfForHost = cookies.filter(
      c => (c.domain.endsWith("axieinfinity.com") || c.domain.includes("graphql-gateway")) &&
           (c.name === "cf_clearance" || c.name === "__cf_bm")
    );
    if (cfForHost.length > 0) return null; // likely passed
    await wait(1000);
  }
  // Even if cookies are not visible, CF may already allow POSTs; continue anyway.
}

async function run(address0x: string): Promise<RunResult> {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? execPath,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  })
  const page = await browser.newPage()

  try {
    await ensureCloudflarePass(page, ENDPOINT)

    const result: RunResult = await page.evaluate(
      async ({ ENDPOINT, QUERY, address0x }) => {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/plain, */*",
            origin: "https://marketplace.axieinfinity.com",
            referer: "https://marketplace.axieinfinity.com/",
          },
          body: JSON.stringify({
            operationName: "GetMiniProfileByRoninAddress",
            query: QUERY,
            variables: {
              address: address0x,
              includeTotalAxies: false,
              includeTotalBadges: false,
            },
          }),
          credentials: "include",
        })

        const text = await res.text()
        let json: any
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 400)}`)
        }

        if (!res.ok || json?.errors) {
          const err =
            (json?.errors as Array<{ message?: string }> | undefined)
              ?.map(e => e.message ?? "Unknown error")
              .join("; ") || text.slice(0, 400)
          throw new Error(`GraphQL error (${res.status}): ${err}`)
        }

        const profile = json?.data?.publicProfileWithRoninAddress
        const stats = profile?.settings?.axieEcosystemStats

        return stats
          ? {
              address: address0x,
              name: profile?.name ?? null,
              axieScore: stats.axieScore,
              title: stats.title,
            }
          : null
      },
      { ENDPOINT, QUERY, address0x }
    )

    // return the evaluated result (object or null)
    return result
  } catch (e) {
    console.error(e instanceof Error ? e.stack ?? e.message : String(e))
    // decide policy: either swallow and return null, or rethrow
    return null
  } finally {
    await browser.close()
  }
}



export async function getData(address0x: string){
  const result = await run(address0x);

    if (!result) return null    

    const { address, name, axieScore, title } = result

    console.log(address);
    console.log(name);
    console.log(axieScore);
    console.log(title);

  return {
    address0x,
    name,
    axieScore,
    title,
  }
}

