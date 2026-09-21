import { QueryEngine } from "../src/engine";
import { keywordRetrieval } from "../src/retrieval";

type Args = ConstructorParameters<typeof QueryEngine>;

/**
 * An engine on the shipped keyword retrieval. Retrieval is a required argument of the
 * engine, so every test crosses the seam production crosses; a test that wants a fixed
 * candidate list passes its own as the last argument.
 */
export function engine(client: Args[0], getBlocks: Args[1], getSourceBlocks?: Args[3], namespace?: Args[4], cache?: Args[5], retrieve: Args[2] = keywordRetrieval): QueryEngine {
  return new QueryEngine(client, getBlocks, retrieve, getSourceBlocks, namespace, cache);
}
