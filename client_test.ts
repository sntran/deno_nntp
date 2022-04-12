import {
  assert,
} from "https://deno.land/std@0.134.0/testing/asserts.ts";
import { Client, Command } from "./client.ts";

Deno.test("Client", async (t) => {
  const client = new Client({
    hostname: "news.php.net",
    port: 119,
  });

  await t.step({
    name: "connect",
    fn: async () => {
      const response = await client.connect();
      assert(response.ok);
      assert(response.statusText);
    },
    ignore: false,
    sanitizeResources: false,
  });

  await t.step("request", async (t) => {

    await t.step("for single-line response", async () => {
      const response = await client.request(Command.DATE);
      // Even though DATE command is responded with 111, it is not
      // an acceptable status code, so we normalize it to 200.
      assert(response.ok, "should normalize status code to 200");
      assert(response.statusText.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/), "should has yyyymmddhhmmss in statusText");

      const body = await response.text();
      assert(!body, "should not have multi-line block body");
    });

    await t.step("for multi-line response", async () => {
      const response = await client.request(Command.HELP);
      // Even though HELP command is responded with 100, it is not
      // an acceptable status code, so we normalize it to 200.
      assert(response.ok, "should normalize status code to 200");

      const body = await response.text();
      assert(body, "should have a multi-line block body");
    });

    await t.step("with arguments", async () => {
      const response = await client.request(Command.GROUP, "php.announce");
      assert(response.status === 211);
      assert(response.statusText.match(/^(\d+) (\d+) (\d+) php.announce$/), "should have group information in statusText");
    });
  });

  client.close();
});
