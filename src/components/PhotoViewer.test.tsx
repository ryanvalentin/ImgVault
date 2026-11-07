import { fireEvent, render, screen, waitFor, within, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import PhotoViewer from './PhotoViewer';
import type { Photo } from '@/lib/mock-data';

const photo: Photo = {
  id: 'photo-1',
  filename: 'photo.jpg',
  path: 'photo.jpg',
  folder: 'Root',
  type: 'image',
  width: 1200,
  height: 800,
  fileSize: 1024,
  thumbnailUrl: '/thumbnail',
  fullUrl: '/photo',
  createdAt: '2024-01-02T03:04:05.123+01:00',
  metadata: {
    dateTaken: '2024-01-02T03:04:05.123+01:00',
    camera: 'Old camera',
    location: 'Old place',
  },
};

const entry = {
  width: 1200, height: 800, date_taken: photo.metadata.dateTaken,
  location: null, camera: 'New camera', lens: 'New lens', iso: 0,
  aperture: null, shutter_speed: null, gps_lat: 0, gps_lng: -0.5,
  country: null, city: null, file_modified_at: '2024-01-01T00:00:00',
};

function Viewer({ initialPhoto = photo }: { initialPhoto?: Photo }) {
  const [selected, setSelected] = useState(initialPhoto);
  return <PhotoViewer photo={selected} photos={[selected]} onClose={vi.fn()} onNavigate={setSelected} onUpdate={setSelected} />;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function openEditor() {
  fireEvent.click(screen.getByRole('button', { name: 'Show info' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
}

describe('photo details editing', () => {
  it('shows all editable fields and saves only changes, including clears and zero coordinates', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(entry), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Viewer />);
    openEditor();

    for (const label of ['Width', 'Height', 'Date taken', 'Location', 'Country', 'City', 'Latitude', 'Longitude', 'Camera', 'Lens', 'ISO', 'Aperture', 'Shutter speed']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByLabelText('Lens')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Camera'), { target: { value: 'New camera' } });
    fireEvent.change(screen.getByLabelText('Lens'), { target: { value: 'New lens' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '-0.5' } });
    fireEvent.change(screen.getByLabelText('ISO'), { target: { value: '0' } });
    fireEvent.keyDown(screen.getByLabelText('Camera'), { key: 'i' });
    expect(screen.getByLabelText('Camera')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith('/api/photos/photo-1', expect.objectContaining({ method: 'PATCH' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      location: null, gps_lat: 0, gps_lng: -0.5, camera: 'New camera', lens: 'New lens', iso: 0,
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument());
    const details = screen.getByText('Details').parentElement?.parentElement;
    expect(details).not.toBeNull();
    expect(within(details!).getByText('New camera')).toBeInTheDocument();
    expect(within(details!).queryByText('Old place')).not.toBeInTheDocument();
  });

  it('keeps entered values and shows an error on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })));
    render(<Viewer />);
    openEditor();
    fireEvent.change(screen.getByLabelText('Lens'), { target: { value: 'Unsaved lens' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed: 500');
    expect(screen.getByLabelText('Lens')).toHaveValue('Unsaved lens');
  });

  it('cancels without saving and starts a fresh form on reopening', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<Viewer />);
    openEditor();
    fireEvent.change(screen.getByLabelText('Camera'), { target: { value: 'Discarded' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Camera')).toHaveValue('Old camera');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a timezone-bearing date in local time without rewriting it when unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(entry), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Viewer />);
    openEditor();
    const date = new Date(photo.metadata.dateTaken!);
    const pad = (value: number) => String(value).padStart(2, '0');
    expect(screen.getByLabelText('Date taken')).toHaveAttribute('type', 'datetime-local');
    expect(screen.getByLabelText('Date taken')).toHaveValue(
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.123`,
    );
    fireEvent.change(screen.getByLabelText('Camera'), { target: { value: 'New camera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ camera: 'New camera' });
  });

  it.each([
    ['2025-03-04T12:34', '2025-03-04T12:34:00'],
    ['2025-03-04T12:34:56.789', '2025-03-04T12:34:56.789'],
    ['', null],
  ])('sends date input %s as %s', async (value, expected) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(entry), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Viewer />);
    openEditor();
    fireEvent.change(screen.getByLabelText('Date taken'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ date_taken: expected });
  });

  it('displays timezone-free and date-only values without shifting them', () => {
    const initialPhoto = { ...photo, metadata: { ...photo.metadata, dateTaken: '2024-01-02T03:04:05' } };
    const { unmount } = render(<Viewer initialPhoto={initialPhoto} />);
    openEditor();
    expect(screen.getByLabelText('Date taken')).toHaveValue('2024-01-02T03:04:05.000');
    unmount();
    render(<Viewer initialPhoto={{ ...initialPhoto, metadata: { dateTaken: '2024-01-02' } }} />);
    openEditor();
    expect(screen.getByLabelText('Date taken')).toHaveValue('2024-01-02T00:00');
  });

  it('makes an invalid stored date explicit and allows clearing it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(entry), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Viewer initialPhoto={{ ...photo, metadata: { dateTaken: 'not a date' } }} />);
    openEditor();
    expect(screen.getByText(/Stored date cannot be displayed/)).toHaveTextContent('not a date');
    fireEvent.click(screen.getByRole('button', { name: 'clear it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ date_taken: null });
  });
});
