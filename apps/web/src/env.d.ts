/** Augments `Window` with properties injected at runtime by the entrypoint. */
interface Window {
  /**
   * Gateway origin, set by the container entrypoint at startup.
   *
   * When empty or absent the client falls back to serving from the same origin
   * as the app — the gateway sits behind the same reverse proxy.  Set the
   * `GATEWAY_URL` environment variable on the container to a fully qualified
   * origin (e.g. `https://chat.example.com`) when the gateway runs on a
   * different host.
   */
  readonly __GATEWAY_URL__?: string;
}