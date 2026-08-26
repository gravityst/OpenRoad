// The car catalogue.
//
// Every marque, model and place name in this game is invented. That is a hard
// requirement, not a stylistic choice — the point is a world that feels real
// without borrowing anyone's trademarks.
//
// Each entry's `spec` is merged over DEFAULT_SPEC in physics/vehicle.js, so a
// car only states what makes it different. The numbers are chosen so the cars
// feel genuinely distinct to drive rather than being one car with different
// paint: the front-drive hatch washes wide when pushed, the rear-drive coupe
// rotates on the throttle, and the rally car is the only thing worth having
// once the tarmac runs out.
//
// tools/catalogcheck.mjs measures every one of them, so the figures shown in
// the garage are the ones you actually get.

import { DRIVE } from '../physics/vehicle.js';

export const CLASSES = {
  city:    { name: 'City',     order: 0 },
  sport:   { name: 'Sport',    order: 1 },
  luxury:  { name: 'Luxury',   order: 2 },
  super:   { name: 'Super',    order: 3 },
  utility: { name: 'Utility',  order: 4 },
  offroad: { name: 'Off-road', order: 5 },
};

export const CARS = [
  {
    id: 'kaida2', brand: 'Tamura', model: 'Kaida Group R',
    class: 'offroad', body: 'hatch', cylinders: 4,
    blurb: 'The homologation one. Anti-lag, a centre diff that hates tarmac, and enough suspension travel to land from a crest without asking permission.',
    colours: [0xf2f4f6, 0x1746a0, 0xd6212a, 0x1b1e22, 0xf0b323],
    spec: {
      mass: 1290, wheelbase: 2.58, track: 1.62, cgHeight: 0.50, cgBias: 0.55,
      wheelRadius: 0.35, rideHeight: 0.38, drive: DRIVE.AWD,
      power: 280000, peakRpm: 6200, redline: 7200,
      gears: [3.42, 2.28, 1.70, 1.34, 1.08, 0.88], finalDrive: 4.10,
      brakeTorque: 3600, brakeBias: 0.58, handbrakeTorque: 3600,
      dragArea: 0.94, downforce: 0.20,
      gripFront: 1.10, gripRear: 1.14,
      springRate: 25000, damping: 3700, maxSteer: 0.68,
    },
  },
  {
    id: 'scout', brand: 'Auroch', model: 'Scout 4x4',
    class: 'offroad', body: 'suv', cylinders: 6,
    blurb: 'Live axles, a low range and the aerodynamics of a shed. It will climb anything and corner like none of it.',
    colours: [0x3f5540, 0xd9d2c2, 0x8a5a2b, 0x1e2226, 0xb8452f],
    spec: {
      mass: 2020, wheelbase: 2.62, track: 1.60, cgHeight: 0.82, cgBias: 0.53,
      wheelRadius: 0.42, rideHeight: 0.52, drive: DRIVE.AWD,
      power: 172000, peakRpm: 5000, redline: 5600,
      gears: [4.62, 2.62, 1.62, 1.18, 0.88], finalDrive: 4.30,
      brakeTorque: 3800, brakeBias: 0.58, handbrakeTorque: 2600,
      dragArea: 1.45, downforce: 0.02,
      gripFront: 0.98, gripRear: 1.02,
      springRate: 24000, damping: 3600, maxSteer: 0.66,
    },
  },
  {
    id: 'ridgeback', brand: 'Norvex', model: 'Ridgeback TRX',
    class: 'offroad', body: 'pickup', cylinders: 8,
    blurb: 'A lifted pickup on knobbly tyres with long-travel dampers. Absurd over a crest, hopeless in a hairpin, and worth it.',
    colours: [0xc8641f, 0x2b2f34, 0xe6e4df, 0x3d5540, 0x8a2f2a],
    spec: {
      mass: 2480, wheelbase: 3.28, track: 1.78, cgHeight: 0.80, cgBias: 0.56,
      wheelRadius: 0.45, rideHeight: 0.55, drive: DRIVE.AWD,
      power: 335000, peakRpm: 5400, redline: 6000,
      gears: [3.86, 2.28, 1.52, 1.16, 0.90, 0.72], finalDrive: 3.90,
      brakeTorque: 4600, brakeBias: 0.60, handbrakeTorque: 2400,
      dragArea: 1.72, downforce: 0.02,
      gripFront: 1.00, gripRear: 1.04,
      springRate: 26000, damping: 3900, maxSteer: 0.62,
    },
  },
  {
    id: 'rs200', brand: 'Verrick', model: 'RS Sport',
    class: 'sport', body: 'coupe', cylinders: 4,
    blurb: 'Mid-engined, four-wheel drive and barely civilised. Built to satisfy a rulebook and never quite tamed afterwards.',
    colours: [0xe8e9eb, 0x1746a0, 0x14161a, 0xd6212a, 0x4b8f3a],
    spec: {
      mass: 1180, wheelbase: 2.53, track: 1.63, cgHeight: 0.44, cgBias: 0.44,
      wheelRadius: 0.33, rideHeight: 0.24, drive: DRIVE.AWD,
      power: 310000, peakRpm: 7200, redline: 8000,
      gears: [3.30, 2.16, 1.62, 1.28, 1.04, 0.86], finalDrive: 3.80,
      brakeTorque: 4400, brakeBias: 0.60, handbrakeTorque: 2800,
      dragArea: 0.72, downforce: 0.42,
      gripFront: 1.18, gripRear: 1.22,
      springRate: 44000, damping: 5400, maxSteer: 0.60,
    },
  },
  {
    id: 'lupo', brand: 'Salvana', model: 'Lupo GT',
    class: 'sport', body: 'sports', cylinders: 6,
    blurb: 'Small, light, rear-drive and utterly uninterested in helping you. The purest thing in the garage.',
    colours: [0xf5c518, 0x1b1d21, 0xbf2233, 0xe9eef2, 0x2a6f9e],
    spec: {
      mass: 1180, wheelbase: 2.45, track: 1.58, cgHeight: 0.43, cgBias: 0.46,
      wheelRadius: 0.33, rideHeight: 0.20, drive: DRIVE.RWD,
      power: 235000, peakRpm: 7400, redline: 8200,
      gears: [3.38, 2.10, 1.56, 1.22, 1.00, 0.82], finalDrive: 3.72,
      brakeTorque: 4000, brakeBias: 0.61, handbrakeTorque: 2600,
      dragArea: 0.66, downforce: 0.34,
      gripFront: 1.14, gripRear: 1.12,
      springRate: 40000, damping: 5000, maxSteer: 0.62,
    },
  },
  {
    id: 'lark', brand: 'Kestrel', model: 'Lark',
    class: 'city', body: 'hatch', cylinders: 4,
    blurb: 'Cheap, willing and impossible to dislike. Front-drive, so it washes wide when you ask too much — which is most of the time.',
    colours: [0xd8dde2, 0xc4322f, 0x2f6fb5, 0x1d2024, 0x8ab54a],
    spec: {
      mass: 1090, wheelbase: 2.51, track: 1.49, cgHeight: 0.55, cgBias: 0.62,
      wheelRadius: 0.30, rideHeight: 0.27, drive: DRIVE.FWD,
      power: 84000, peakRpm: 5800, redline: 6400,
      gears: [3.73, 2.05, 1.39, 1.03, 0.82], finalDrive: 4.06,
      brakeTorque: 2100, brakeBias: 0.68, handbrakeTorque: 1500,
      dragArea: 0.74, downforce: 0.05,
      gripFront: 0.97, gripRear: 0.95,
      springRate: 26000, damping: 3200, maxSteer: 0.64,
    },
  },
  {
    id: 'kaze', brand: 'Tamura', model: 'Kaze GT',
    class: 'sport', body: 'coupe', cylinders: 4,
    blurb: 'Light, rear-drive and deliberately a little tail-happy. The one to learn to drift in.',
    colours: [0xe4e7ea, 0x1b1d21, 0xd94f18, 0x2b7f6d, 0xf0c419],
    spec: {
      mass: 1290, wheelbase: 2.57, track: 1.54, cgHeight: 0.47, cgBias: 0.53,
      wheelRadius: 0.32, rideHeight: 0.24, drive: DRIVE.RWD,
      power: 149000, peakRpm: 6800, redline: 7400,
      gears: [3.63, 2.19, 1.54, 1.21, 1.00, 0.79], finalDrive: 3.91,
      brakeTorque: 2900, brakeBias: 0.62, handbrakeTorque: 2400,
      dragArea: 0.60, downforce: 0.14,
      // Rear peak deliberately below the front: that is what makes it rotate.
      gripFront: 1.05, gripRear: 1.03,
      springRate: 33000, damping: 4100, maxSteer: 0.62,
    },
  },
  {
    id: 'v340', brand: 'Verrick', model: '340S',
    class: 'luxury', body: 'sedan', cylinders: 6,
    blurb: 'A big straight-six saloon that hides its weight well. Fast everywhere, dramatic nowhere.',
    colours: [0x2a3038, 0xb8bcc0, 0x11131a, 0x5a2c34, 0x27455e],
    spec: {
      mass: 1620, wheelbase: 2.87, track: 1.61, cgHeight: 0.51, cgBias: 0.51,
      wheelRadius: 0.35, rideHeight: 0.27, drive: DRIVE.RWD,
      power: 250000, peakRpm: 6200, redline: 6900,
      gears: [3.55, 2.05, 1.42, 1.05, 0.84, 0.68, 0.57], finalDrive: 3.31,
      brakeTorque: 3900, brakeBias: 0.63, handbrakeTorque: 2500,
      dragArea: 0.78, downforce: 0.20,
      gripFront: 1.07, gripRear: 1.09,
      springRate: 36000, damping: 4600, maxSteer: 0.60,
    },
  },
  {
    id: 'corsara', brand: 'Salvana', model: 'Corsara',
    class: 'super', body: 'sports', cylinders: 8,
    blurb: 'Mid-engined, wide and loud. Enormous grip, right up until it runs out.',
    colours: [0xc21f26, 0xf2e9d8, 0x0f1216, 0xf5a623, 0x1f5f8b],
    spec: {
      mass: 1440, wheelbase: 2.65, track: 1.68, cgHeight: 0.42, cgBias: 0.42,
      wheelRadius: 0.35, rideHeight: 0.16, drive: DRIVE.RWD,
      power: 449000, peakRpm: 7600, redline: 8400,
      gears: [3.21, 2.11, 1.58, 1.24, 1.00, 0.83, 0.70], finalDrive: 3.62,
      brakeTorque: 5400, brakeBias: 0.60, handbrakeTorque: 2600,
      dragArea: 0.76, downforce: 0.62,
      gripFront: 1.24, gripRear: 1.30,
      springRate: 52000, damping: 6200, maxSteer: 0.58, steerRate: 4.0,
    },
  },
  {
    id: 'arc', brand: 'Halcyon', model: 'Arc',
    class: 'super', body: 'sports', cylinders: 0,   // electric: no firing order
    blurb: 'All-wheel drive, one gear, and every newton-metre available from a standstill. Silent and brutally quick.',
    colours: [0x1b8f9e, 0xe8eaed, 0x14161a, 0x7b4bd4, 0xd0d64a],
    spec: {
      mass: 2050, wheelbase: 2.90, track: 1.66, cgHeight: 0.38, cgBias: 0.48,
      wheelRadius: 0.36, rideHeight: 0.20, drive: DRIVE.AWD,
      // A single reduction gear, so "rpm" here is motor speed and the redline
      // is only a limiter — it never shifts.
      power: 500000, peakRpm: 4200, redline: 14000, idleRpm: 0,
      gears: [1.00], finalDrive: 7.35, shiftTime: 0,
      brakeTorque: 5200, brakeBias: 0.58, handbrakeTorque: 2400,
      dragArea: 0.54, downforce: 0.30,
      gripFront: 1.18, gripRear: 1.20,
      springRate: 46000, damping: 5800, maxSteer: 0.58,
    },
  },
  {
    id: 'bastion', brand: 'Auroch', model: 'Bastion',
    class: 'offroad', body: 'suv', cylinders: 6,
    blurb: 'Tall, heavy and permanently four-wheel drive. Leans in corners and does not care where the road went.',
    colours: [0x3d4a3a, 0xd8d4cc, 0x7a5230, 0x1a1c1f, 0x2c4f6b],
    spec: {
      mass: 2180, wheelbase: 2.89, track: 1.68, cgHeight: 0.74, cgBias: 0.54,
      wheelRadius: 0.40, rideHeight: 0.42, drive: DRIVE.AWD,
      power: 224000, peakRpm: 5600, redline: 6200,
      gears: [4.17, 2.34, 1.52, 1.14, 0.87, 0.69], finalDrive: 3.73,
      brakeTorque: 4200, brakeBias: 0.60, handbrakeTorque: 2200,
      dragArea: 1.18, downforce: 0.04,
      gripFront: 1.00, gripRear: 1.02,
      springRate: 30000, damping: 4400, maxSteer: 0.60,
    },
  },
  {
    id: 'kaida', brand: 'Tamura', model: 'Kaida RS',
    class: 'offroad', body: 'hatch', cylinders: 4,
    blurb: 'A rally car with number plates. Long-travel suspension, all-wheel drive and a handbrake that means it.',
    colours: [0x1c4fa0, 0xe9edf0, 0xd6212a, 0x2b2f34, 0xf0b323],
    spec: {
      mass: 1420, wheelbase: 2.60, track: 1.58, cgHeight: 0.52, cgBias: 0.57,
      wheelRadius: 0.34, rideHeight: 0.34, drive: DRIVE.AWD,
      power: 224000, peakRpm: 6000, redline: 6800,
      gears: [3.64, 2.24, 1.61, 1.24, 0.98, 0.80], finalDrive: 3.90,
      brakeTorque: 3300, brakeBias: 0.60, handbrakeTorque: 3200,
      dragArea: 0.92, downforce: 0.16,
      gripFront: 1.08, gripRear: 1.10,
      // Soft, long-travel springs: this is the car that stays composed once the
      // tarmac runs out, where everything else is skating.
      springRate: 27000, damping: 3900, maxSteer: 0.66, steerRate: 3.8,
    },
  },
  {
    id: 'haulier', brand: 'Norvex', model: 'Haulier',
    class: 'utility', body: 'pickup', cylinders: 8,
    blurb: 'A working pickup. Torque everywhere, an empty bed over the rear axle, and the traction that implies.',
    colours: [0x9a2f2a, 0xe6e4df, 0x2f3a44, 0x1c1e21, 0x6b7a3a],
    spec: {
      mass: 2340, wheelbase: 3.34, track: 1.72, cgHeight: 0.72, cgBias: 0.58,
      wheelRadius: 0.41, rideHeight: 0.40, drive: DRIVE.RWD,
      power: 246000, peakRpm: 5200, redline: 5800,
      gears: [3.97, 2.32, 1.52, 1.14, 0.86, 0.69], finalDrive: 3.55,
      brakeTorque: 4300, brakeBias: 0.64, handbrakeTorque: 2000,
      dragArea: 1.62, downforce: 0.02,
      gripFront: 1.00, gripRear: 0.94,      // light tail: it will step out
      springRate: 31000, damping: 4300, maxSteer: 0.58,
    },
  },
  {
    id: 'drover', brand: 'Kestrel', model: 'Drover',
    class: 'utility', body: 'van', cylinders: 4,
    blurb: 'A delivery van. Slow, tall and hilarious to throw at a roundabout.',
    colours: [0xe8e8e6, 0x2b5fa8, 0xd6d21f, 0x3a3d42, 0x8a4b2a],
    spec: {
      mass: 1960, wheelbase: 3.10, track: 1.63, cgHeight: 0.82, cgBias: 0.57,
      wheelRadius: 0.35, rideHeight: 0.33, drive: DRIVE.FWD,
      power: 105000, peakRpm: 4200, redline: 4800,
      gears: [3.82, 2.13, 1.36, 0.98, 0.76], finalDrive: 4.19,
      brakeTorque: 3100, brakeBias: 0.66, handbrakeTorque: 1800,
      dragArea: 1.38, downforce: 0.02,
      gripFront: 0.95, gripRear: 0.93,
      springRate: 27000, damping: 3800, maxSteer: 0.60,
    },
  },
  {
    id: 'meridian', brand: 'Verrick', model: 'Meridian',
    class: 'luxury', body: 'sedan', cylinders: 8,
    blurb: 'The long-wheelbase one. Enormous, hushed, and considerably faster than it looks.',
    colours: [0x14161b, 0xbfc4c9, 0x33404d, 0x5c4a33, 0x7d1f24],
    spec: {
      mass: 1980, wheelbase: 3.21, track: 1.66, cgHeight: 0.50, cgBias: 0.50,
      wheelRadius: 0.37, rideHeight: 0.26, drive: DRIVE.AWD,
      power: 380000, peakRpm: 6000, redline: 6600,
      gears: [3.44, 2.05, 1.44, 1.09, 0.87, 0.72, 0.60], finalDrive: 3.15,
      brakeTorque: 4700, brakeBias: 0.61, handbrakeTorque: 2400,
      dragArea: 0.96, downforce: 0.24,
      gripFront: 1.10, gripRear: 1.12,
      springRate: 38000, damping: 5000, maxSteer: 0.58,
    },
  },
];

export const CAR_BY_ID = Object.fromEntries(CARS.map((c) => [c.id, c]));

/** The car a new player starts in. */
// The starter is a rally car, not a shopping car.
//
// It was a city hatch at the top of the list in a world that is now open roads,
// gravel stages and circuits — the first thing a player drove was the least
// interesting thing in the garage, on the surface it is worst at.
export const STARTER = 'kaida2';

/**
 * Everything the physics needs for one car, ready to hand to createVehicle.
 * `colour` is carried through so the renderer and the menu agree on the paint.
 */
export function specFor(id, colourIndex = 0) {
  const car = CAR_BY_ID[id] || CAR_BY_ID[STARTER];
  return {
    ...car.spec,
    name: `${car.brand} ${car.model}`,
    id: car.id,
    body: car.body,
    cylinders: car.cylinders,
    colour: car.colours[colourIndex % car.colours.length],
  };
}
