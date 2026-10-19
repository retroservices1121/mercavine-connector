import { searchNative, type ProductView } from "@/lib/catalog";

/**
 * Curated featured entries shown on the homepage when no seller has an
 * in-stock listing yet. Details come from the manufacturer's own product page;
 * there is no Mercavine seller, stock, or rating attached to these.
 */
export type CuratedProduct = {
  id: string;
  brand: string;
  title: string;
  model: string;
  category: string;
  specs: string[];
  listPriceCents: number;
  sourceUrl: string;
};

export const curatedFeatured: CuratedProduct[] = [
  {
    id: "anker-a121d",
    brand: "Anker",
    title: "Anker Nano Charger (45W, Smart Display, 180° Foldable)",
    model: "A121D",
    category: "electronics-accessories",
    specs: ["Up to 45W USB-C fast charging", "Rotating smart display", "90° and 180° foldable prongs"],
    listPriceCents: 3999,
    sourceUrl: "https://www.anker.com/products/a121d-45w-smart-display-charger-dual-foldable",
  },
];

export type FeaturedItem =
  | { kind: "listing"; product: ProductView; offer: ProductView["offers"][number] }
  | { kind: "curated"; product: CuratedProduct };

export function featuredItems(
  listings: () => ProductView[] = () => searchNative({ limit: 8, inStock: true }),
  curated: CuratedProduct[] = curatedFeatured,
): FeaturedItem[] {
  const live = listings()
    .filter((product) => product.offers[0])
    .map((product) => ({ kind: "listing" as const, product, offer: product.offers[0] }))
    .slice(0, 6);
  if (live.length) return live;
  return curated.slice(0, 6).map((product) => ({ kind: "curated" as const, product }));
}
