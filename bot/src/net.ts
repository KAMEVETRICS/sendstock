import { Resolver } from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";

/**
 * Routes all fetch() DNS lookups through the given servers. Used in local dev on networks
 * whose default resolver blocks binance.com; leave DNS_SERVERS empty in production.
 */
export function useDnsServers(servers: string[]): void {
  if (servers.length === 0) return;
  const resolver = new Resolver();
  resolver.setServers(servers);

  setGlobalDispatcher(
    new Agent({
      connect: {
        lookup(hostname, options, callback) {
          resolver.resolve4(hostname, (err, addresses) => {
            if (err || addresses.length === 0) return callback(err ?? new Error(`No A record for ${hostname}`), "", 4);
            if (options.all) return callback(null, addresses.map((address) => ({ address, family: 4 })) as never, 4);
            callback(null, addresses[0], 4);
          });
        },
      },
    }),
  );
}
