import { z } from "zod";

(globalThis as unknown as { z: typeof z }).z = z;
