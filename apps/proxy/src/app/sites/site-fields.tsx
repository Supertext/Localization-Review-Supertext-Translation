import type { ReviewSite } from '@/lib/review-links';

/** The editable fields of a review site (create and edit forms). */
export default function SiteFields({ site }: { site?: ReviewSite }) {
  const prefixes = site ? Object.entries(site.target_prefixes).map(([l, p]) => `${l} ${p}`).join('\n') : '';
  return (
    <>
      <label>
        Name
        <input name="name" defaultValue={site?.name ?? ''} maxLength={200} placeholder="Kunde AG website" />
      </label>
      <label>
        Site address
        <input name="origin" type="url" required defaultValue={site?.origin ?? ''} placeholder="https://www.kunde.ch" />
      </label>
      <div className="grid2" style={{ gap: 12 }}>
        <label>
          Source language (Supertext code)
          <input name="source_lang" defaultValue={site?.source_lang ?? ''} placeholder="de (empty: detected)" maxLength={40} />
        </label>
        <label>
          Source path prefix
          <input name="source_prefix" defaultValue={site?.source_prefix ?? ''} placeholder="/de/" maxLength={200} />
        </label>
      </div>
      <label>
        Target languages and their path prefixes, one per line
        <textarea name="target_prefixes" defaultValue={prefixes} placeholder={'fr-CH /fr/\nit-CH /it/'} />
        <span className="small muted" style={{ fontWeight: 400 }}>
          The extension uses the prefixes to open the matching page of the other language. Sites with other URL schemes: leave them empty
          and open both pages by hand.
        </span>
      </label>
    </>
  );
}
