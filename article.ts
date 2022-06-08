export class Article implements RequestInit {
  body?: BodyInit | null;
  headers: Headers;
  number?: number;

  constructor(init: string | RequestInit = {}) {
    if (typeof init === "string") {
      init = {
        headers: {
          "message-id": init,
        },
      };
    }
    this.headers = new Headers(init.headers);
    this.body = init.body;
  }

  get id() {
    return this.headers.get("message-id");
  }

  /**
   * Converts an Article object to a ReadableStream suitable for sending
   * to NNTP server after a POST or IHAVE.
   */
  stream(): ReadableStream<Uint8Array> {
    const { headers, body } = this;
    let reader: ReadableStreamDefaultReader;

    const encoder = new TextEncoder();
    const CRLF = encoder.encode("\r\n");

    const source: UnderlyingSource<Uint8Array> = {
      start(controller) {
        // Enqueued all the header lines first.
        const lines: string[] = [];
        headers.forEach((value, key) => {
          lines.push(`${key}: ${value}\r\n`);
        });
        controller.enqueue(encoder.encode(lines.join("")));

        if (!body) {
          controller.close();
          return;
        }

        if (lines.length) {
          controller.enqueue(CRLF);
        }

        if (typeof body === "string") {
          controller.enqueue(encoder.encode(`${body}\r\n.\r\n`));
          controller.close();
        }
      },
      async pull(controller) {
        // Should only be called here when body is not string.
        if (!reader) {
          reader = (body as ReadableStream).getReader();
        }
        const { done, value } = await reader.read();
        // When no more data needs to be consumed, close the stream
        if (done) {
          if (value) {
            controller.enqueue(value.slice());
          }

          // Since the intial `body` does not contain the termination line,
          // we need to enqueue it as the last one to end the request.
          controller.enqueue(encoder.encode(`.\r\n`));
          controller.close();
          return;
        }
        // Enqueue the next data chunk into our target stream
        controller.enqueue(value.slice());
      },
    };

    return new ReadableStream<Uint8Array>(source);
  }
}
