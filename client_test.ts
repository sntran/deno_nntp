import {
  assert,
  assertEquals,
  assertMatch,
} from "./dev_deps.ts";
import { Client, Command } from "./mod.ts";

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
      assertEquals(response.status, 111);
      assertMatch(response.statusText, /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, "should has yyyymmddhhmmss in statusText");

      const body = await response.text();
      assert(!body, "should not have multi-line block body");
    });

    await t.step("for multi-line response", async () => {
      const response = await client.request(Command.HELP);
      assertEquals(response.status, 100);

      const body = await response.text();
      assert(body, "should have a multi-line block body");
    });

    await t.step("not returns terminating line in response", async () => {
      const response = await client.request(Command.HELP);
      const body = await response.text();
      assert(!/\.$/.test(body), "should not have an ending dot");
      assert(!/\.\r\n$/.test(body), "should not have terminating line");
    });

    await t.step("undo dot stuffing", async () => {
      const response = await client.request(Command.HELP);
      const body = await response.text();
      assert(body.indexOf(".\r\n") === -1, "should not have any dot-stuffed line");
    });

    await t.step("with arguments", async () => {
      const response = await client.request(Command.GROUP, "php.announce");
      assertEquals(response.status, 211);
      assertMatch(response.statusText, /^(\d+) (\d+) (\d+) php.announce$/, "should have group information in statusText");
      const body = await response.text();
      assert(!body);
    });

    await t.step("GROUP vs LISTGROUP", async () => {
      const response = await client.request(Command.LISTGROUP, "php.announce");
      assertEquals(response.status, 211);
      const body = await response.text();
      assert(body, "should have body");
    });
  });

  client.close();
});
