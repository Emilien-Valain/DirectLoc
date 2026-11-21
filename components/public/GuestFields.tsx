import { COUNTRIES, DEFAULT_COUNTRY } from "@/lib/countries";

/** « Pour vous joindre » : identité du voyageur, saisie une fois quel que soit le nombre de chambres. */
export default function GuestFields({
  values: v,
  fieldErrors,
}: {
  /** Saisie rendue par le serveur après une erreur. */
  values: Record<string, string>;
  fieldErrors?: Record<string, string>;
}) {
  return (
    <fieldset className="s-group">
      <legend className="s-h3">Pour vous joindre</legend>
      <div className="s-grid-2">
        <div className="s-field">
          <label htmlFor="guestFirstName">Prénom</label>
          <input
            id="guestFirstName"
            type="text"
            name="guestFirstName"
            required
            maxLength={100}
            autoComplete="given-name"
            defaultValue={v.guestFirstName}
            aria-invalid={!!fieldErrors?.guestFirstName || undefined}
          />
        </div>
        <div className="s-field">
          <label htmlFor="guestLastName">Nom</label>
          <input
            id="guestLastName"
            type="text"
            name="guestLastName"
            required
            maxLength={100}
            autoComplete="family-name"
            defaultValue={v.guestLastName}
            aria-invalid={!!fieldErrors?.guestLastName || undefined}
          />
        </div>
        <div className="s-field">
          <label htmlFor="guestEmail">Email</label>
          <input id="guestEmail" type="email" name="guestEmail" required autoComplete="email" defaultValue={v.guestEmail} />
        </div>
        <div className="s-field">
          <label htmlFor="guestPhone">Téléphone</label>
          <input
            id="guestPhone"
            type="tel"
            name="guestPhone"
            required
            autoComplete="tel"
            defaultValue={v.guestPhone}
            aria-invalid={!!fieldErrors?.guestPhone || undefined}
          />
        </div>
      </div>
      <div className="s-field">
        <label htmlFor="guestAddress">Adresse postale</label>
        <input
          id="guestAddress"
          type="text"
          name="guestAddress"
          required
          minLength={5}
          maxLength={300}
          autoComplete="street-address"
          placeholder="12 rue des Lilas, 84000 Avignon"
          defaultValue={v.guestAddress}
          aria-invalid={!!fieldErrors?.guestAddress || undefined}
        />
      </div>
      <div className="s-field">
        <label htmlFor="guestCountry">Pays de résidence</label>
        <select
          id="guestCountry"
          name="guestCountry"
          required
          autoComplete="country"
          defaultValue={v.guestCountry || DEFAULT_COUNTRY}
          aria-invalid={!!fieldErrors?.guestCountry || undefined}
        >
          {COUNTRIES.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </div>
    </fieldset>
  );
}
