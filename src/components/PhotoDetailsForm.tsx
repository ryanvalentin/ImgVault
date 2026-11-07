import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updatePhoto, type PhotoMetadataUpdate } from "@/lib/api-client";
import type { Photo } from "@/lib/mock-data";

type FieldName = keyof PhotoMetadataUpdate;

const fields: {
  name: FieldName;
  label: string;
  type?: "number" | "datetime-local";
  min?: string | number;
  max?: string | number;
  step?: string;
}[] = [
  { name: "width", label: "Width", type: "number", min: 0, step: "1" },
  { name: "height", label: "Height", type: "number", min: 0, step: "1" },
  {
    name: "date_taken",
    label: "Date taken",
    type: "datetime-local",
    step: "any",
    max: new Date().toISOString().slice(0, 16),
  },
  { name: "camera", label: "Camera" },
  { name: "lens", label: "Lens" },
  { name: "iso", label: "ISO", type: "number", min: 0, step: "1" },
  { name: "aperture", label: "Aperture" },
  { name: "shutter_speed", label: "Shutter speed" },
  {
    name: "gps_lat",
    label: "Latitude",
    type: "number",
    min: -90,
    max: 90,
    step: "any",
  },
  {
    name: "gps_lng",
    label: "Longitude",
    type: "number",
    min: -180,
    max: 180,
    step: "any",
  },
  { name: "location", label: "Location" },
  { name: "country", label: "Country" },
  { name: "city", label: "City" },
];

function dateForInput(value: string | null | undefined): string {
  if (!value) return "";
  const localDate =
    /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/.exec(
      value,
    );
  if (localDate) {
    const [year, month, day] = localDate[1].split("-").map(Number);
    const [hour, minute] = (localDate[2] || "00:00").split(":").map(Number);
    const second = Number(localDate[3] || 0);
    const check = new Date(`${localDate[1]}T00:00:00Z`);
    if (
      Number.isNaN(check.getTime()) ||
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() + 1 !== month ||
      check.getUTCDate() !== day ||
      hour > 23 ||
      minute > 59 ||
      second > 59
    )
      return "";
    const seconds = localDate[3] ? `:${localDate[3]}` : "";
    const fraction = localDate[4] ? `.${localDate[4].slice(0, 3)}` : "";
    return `${localDate[1]}T${localDate[2] || "00:00"}${seconds}${fraction}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  const milliseconds = date.getMilliseconds();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${milliseconds ? `.${String(milliseconds).padStart(3, "0")}` : ""}`;
}

function initialValues(photo: Photo): Record<FieldName, string> {
  const values = {
    width: photo.width,
    height: photo.height,
    date_taken: dateForInput(photo.metadata.dateTaken),
    location: photo.metadata.location,
    country: photo.metadata.country,
    city: photo.metadata.city,
    gps_lat: photo.metadata.gpsLat,
    gps_lng: photo.metadata.gpsLng,
    camera: photo.metadata.camera,
    lens: photo.metadata.lens,
    iso: photo.metadata.iso,
    aperture: photo.metadata.aperture,
    shutter_speed: photo.metadata.shutterSpeed,
  };
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      value == null ? "" : String(value),
    ]),
  ) as Record<FieldName, string>;
}

interface PhotoDetailsFormProps {
  photo: Photo;
  onCancel: () => void;
  onSaved: (photo: Photo) => void;
}

export default function PhotoDetailsForm({
  photo,
  onCancel,
  onSaved,
}: PhotoDetailsFormProps) {
  const [original] = useState(() => initialValues(photo));
  const [values, setValues] = useState(original);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [clearInvalidDate, setClearInvalidDate] = useState(false);
  const invalidStoredDate = !!photo.metadata.dateTaken && !original.date_taken;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const updates: PhotoMetadataUpdate = {};
    for (const field of fields) {
      const value = values[field.name];
      if (
        value === original[field.name] &&
        !(field.name === "date_taken" && clearInvalidDate)
      )
        continue;
      if (field.type === "number") {
        const numericValue = value === "" ? null : Number(value);
        if (numericValue !== null && !Number.isFinite(numericValue)) {
          setError(`${field.label} must be a valid number.`);
          return;
        }
        Object.assign(updates, { [field.name]: numericValue });
      } else if (field.type === "datetime-local") {
        Object.assign(updates, {
          [field.name]: value
            ? value.length === 16
              ? `${value}:00`
              : value
            : null,
        });
      } else {
        Object.assign(updates, { [field.name]: value === "" ? null : value });
      }
    }

    if (Object.keys(updates).length === 0) {
      onCancel();
      return;
    }

    setSaving(true);
    setError("");
    try {
      const updated = await updatePhoto(photo, updates);
      onSaved(updated);
    } catch (err) {
      setError(
        err instanceof Error
          ? `Could not save changes: ${err.message}`
          : "Could not save changes.",
      );
      setSaving(false);
    }
  };

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <p className="text-xs text-muted-foreground">
        Changes update the library index, not the original file. Edited fields
        are preserved during reindexing.
      </p>
      {fields.map((field) => (
        <div key={field.name} className="space-y-1">
          <label
            htmlFor={`photo-${field.name}`}
            className="text-xs text-muted-foreground"
          >
            {field.label}
          </label>
          <Input
            id={`photo-${field.name}`}
            type={field.type || "text"}
            min={field.min}
            max={field.max}
            step={field.step}
            value={values[field.name]}
            onChange={(event) => {
              setValues((prev) => ({
                ...prev,
                [field.name]: event.target.value,
              }));
              if (field.name === "date_taken") setClearInvalidDate(false);
            }}
            disabled={saving}
          />
          {field.name === "date_taken" && (
            <p className="text-xs text-muted-foreground">
              Dates are edited in your local time and saved without a timezone.
            </p>
          )}
          {field.name === "date_taken" &&
            invalidStoredDate &&
            !values.date_taken &&
            !clearInvalidDate && (
              <p className="text-xs text-destructive">
                Stored date cannot be displayed: {photo.metadata.dateTaken}.
                Enter a new date or{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => setClearInvalidDate(true)}
                  disabled={saving}
                >
                  clear it
                </button>
                .
              </p>
            )}
          {field.name === "date_taken" && clearInvalidDate && (
            <p className="text-xs text-muted-foreground">
              The stored date will be cleared when you save.
            </p>
          )}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Changing coordinates does not automatically update the location, city,
        or country.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
