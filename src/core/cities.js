'use strict';

// Built-in list of Egyptian cities (approximate city-centre coordinates).
// Default city: Cairo.
const CITIES = [
  { name: 'Cairo', latitude: 30.0444, longitude: 31.2357 },
  { name: 'Giza', latitude: 30.0131, longitude: 31.2089 },
  { name: 'Alexandria', latitude: 31.2001, longitude: 29.9187 },
  { name: 'Port Said', latitude: 31.2653, longitude: 32.3019 },
  { name: 'Suez', latitude: 29.9668, longitude: 32.5498 },
  { name: 'Ismailia', latitude: 30.5965, longitude: 32.2715 },
  { name: 'Mansoura', latitude: 31.0409, longitude: 31.3785 },
  { name: 'Tanta', latitude: 30.7865, longitude: 31.0004 },
  { name: 'Zagazig', latitude: 30.5877, longitude: 31.502 },
  { name: 'Damietta', latitude: 31.4165, longitude: 31.8133 },
  { name: 'Damanhur', latitude: 31.0341, longitude: 30.4682 },
  { name: 'Kafr El-Sheikh', latitude: 31.1107, longitude: 30.9388 },
  { name: 'Banha', latitude: 30.466, longitude: 31.1848 },
  { name: 'Shibin El-Kom', latitude: 30.5594, longitude: 31.0119 },
  { name: 'Fayoum', latitude: 29.3084, longitude: 30.8428 },
  { name: 'Beni Suef', latitude: 29.0661, longitude: 31.0994 },
  { name: 'Minya', latitude: 28.1099, longitude: 30.7503 },
  { name: 'Asyut', latitude: 27.1809, longitude: 31.1837 },
  { name: 'Sohag', latitude: 26.5591, longitude: 31.6957 },
  { name: 'Qena', latitude: 26.1551, longitude: 32.716 },
  { name: 'Luxor', latitude: 25.6872, longitude: 32.6396 },
  { name: 'Aswan', latitude: 24.0889, longitude: 32.8998 },
  { name: 'Hurghada', latitude: 27.2579, longitude: 33.8116 },
  { name: 'Sharm El-Sheikh', latitude: 27.9158, longitude: 34.33 },
  { name: 'Marsa Matruh', latitude: 31.3543, longitude: 27.2373 },
  { name: 'Arish', latitude: 31.1316, longitude: 33.7984 },
  { name: 'El-Tor', latitude: 28.2417, longitude: 33.6222 },
  { name: 'Kharga', latitude: 25.439, longitude: 30.5586 },
];

const DEFAULT_CITY = 'Cairo';

function findCity(name) {
  return CITIES.find((c) => c.name === name) || null;
}

module.exports = { CITIES, DEFAULT_CITY, findCity };
