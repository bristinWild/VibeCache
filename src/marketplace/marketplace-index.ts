import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const EntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  category: z.string().min(1),
  status: z.literal('approved'),
  publisher: z.string().min(1),
});

const IndexSchema = z.object({
  schemaVersion: z.literal(1),
  catalog: z.string().min(1),
  updatedAt: z.string().datetime({ offset: true }),
  entries: z.array(EntrySchema),
});

export type MarketplaceEntry = z.infer<typeof EntrySchema>;

export function loadMarketplaceIndex(): MarketplaceEntry[] {
  const path = join(__dirname, '../../marketplace/index.json');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return IndexSchema.parse(parsed).entries;
}
