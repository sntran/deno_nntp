# denntp

A Deno-based NNTP client.

Each request to the NNTP server results in a `Response` containing the
status code, status text, headers, and/or a `ReadbleStream` body.

## Usage

```ts
import { Client } from "https://deno.land/x/nntp/mod.ts";

const client: Client = await Client.connect({
  hostname: "localhost",
  port: 119,
});

const response: Response = await client.capabilities();
console.log({
  ...response,
  body: await response.text(),
});
```

More exxamples can be found in [`examples`](./examples/) folder.

## Client Inferface

```ts
export interface NNTPClient  {
  capabilities(keyword?: string): Promise<Response>
  modeReader(): Promise<Response>
  quit(): Promise<Response>
  group(group?: string): Promise<Response>
  listgroup(group?: string, range?: string): Promise<Response>
  last(): Promise<Response>
  next(): Promise<Response>
  article(number?: number): Promise<Response>
  article(messageId?: string): Promise<Response>
  head(number?: number): Promise<Response>
  head(messageId?: string): Promise<Response>
  body(number?: number): Promise<Response>
  body(messageId?: string): Promise<Response>
  stat(number?: number): Promise<Response>
  stat(messageId?: string): Promise<Response>
  post(article: Article): Promise<Response>
  ihave(messageId: string, article: Article): Promise<Response>
  date(): Promise<Response>
  help(): Promise<Response>
  newgroups(date: string, time: string, isGMT?: boolean): Promise<Response>
  newnews(wildmat: wildmat, date: string, time: string, isGMT?: boolean): Promise<Response>
  list(keyword?: string, arg?: wildmat|parameter): Promise<Response>
  over(messageId?: string): Promise<Response>
  over(range?: string): Promise<Response>
  over(arg?: string): Promise<Response>
  hdr(field: string, messageId?: string): Promise<Response>
  hdr(field: string, range?: string): Promise<Response>
  hdr(field: string, arg?: string): Promise<Response>
  authinfo(username: string, password?: string): Promise<Response>
}
```
