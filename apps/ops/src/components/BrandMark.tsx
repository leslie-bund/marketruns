export default function BrandMark({ small = false }: { small?: boolean }) {
  return <img className={`brand-mark${small ? " small" : ""}`} src="/market-runs.svg" alt="" aria-hidden="true" />;
}
