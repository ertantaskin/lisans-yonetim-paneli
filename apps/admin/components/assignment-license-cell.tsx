type Field = { key: string; label: string; value: string; secret: boolean };

interface Props {
  kind: string;
  payload: string;
  fields: Field[] | null;
}

/**
 * Atama lisans hücresi — kimlik-doğrulamalı admin panelinde lisans/hesap DÜZ gösterilir
 * (maskeleme yok; kullanıcı isteği). Görüntüleme sunucu tarafında audit'e düşer (detail()).
 * Hesap ürününde alan-alan (kullanıcı adı + parola açık); diğer tiplerde tek düz payload.
 */
export function AssignmentLicenseCell({ kind, payload, fields }: Props) {
  if (kind === 'account' && fields) {
    return (
      <div className="space-y-0.5">
        {fields.map((f) => (
          <div key={f.key} className="flex flex-wrap gap-1.5 font-mono text-xs">
            <span className="text-muted-foreground">{f.label}:</span>
            <span className="break-all text-foreground/80">{f.value}</span>
          </div>
        ))}
      </div>
    );
  }
  return <code className="block break-all font-mono text-sm text-foreground/80">{payload}</code>;
}
