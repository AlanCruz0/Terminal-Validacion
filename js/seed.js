// Generador determinista de la lista de invitados de demostración.
// Misma semilla → mismos invitados en cualquier dispositivo (útil para pruebas y revisión).

export const CATEGORY_LABELS = {
  general: 'General',
  vip: 'VIP',
  staff: 'Staff',
  prensa: 'Prensa',
  proveedor: 'Proveedor',
};

const CATEGORY_WEIGHTS = [
  ['general', 68],
  ['vip', 12],
  ['staff', 8],
  ['prensa', 6],
  ['proveedor', 6],
];

const FIRST_F = [
  'María', 'Guadalupe', 'Juana', 'Margarita', 'Verónica', 'Leticia', 'Rosa', 'Fernanda', 'Sofía', 'Valentina',
  'Camila', 'Regina', 'Ximena', 'Daniela', 'Andrea', 'Mariana', 'Gabriela', 'Paola', 'Alejandra', 'Lucía',
  'Natalia', 'Isabella', 'Renata', 'Victoria', 'Elena', 'Patricia', 'Carmen', 'Adriana', 'Claudia', 'Diana',
  'Mónica', 'Karla', 'Brenda', 'Itzel', 'Montserrat', 'Ana', 'Laura', 'Silvia', 'Teresa', 'Abril',
];

const FIRST_M = [
  'José', 'Juan', 'Luis', 'Carlos', 'Jorge', 'Miguel', 'Alejandro', 'Fernando', 'Ricardo', 'Eduardo',
  'Roberto', 'Francisco', 'Javier', 'Daniel', 'Diego', 'Santiago', 'Mateo', 'Sebastián', 'Leonardo', 'Emiliano',
  'Andrés', 'Rodrigo', 'Héctor', 'Raúl', 'Arturo', 'Sergio', 'Manuel', 'Óscar', 'Pablo', 'Iván',
  'Gerardo', 'Alberto', 'Adrián', 'Emilio', 'Ángel', 'Hugo', 'Rafael', 'Tomás', 'Joaquín', 'Gael',
];

const LAST = [
  'Hernández', 'García', 'Martínez', 'López', 'González', 'Pérez', 'Rodríguez', 'Sánchez', 'Ramírez', 'Cruz',
  'Flores', 'Gómez', 'Morales', 'Vázquez', 'Reyes', 'Jiménez', 'Torres', 'Díaz', 'Gutiérrez', 'Ruiz',
  'Mendoza', 'Aguilar', 'Ortiz', 'Moreno', 'Castillo', 'Romero', 'Álvarez', 'Méndez', 'Chávez', 'Rivera',
  'Juárez', 'Ramos', 'Domínguez', 'Herrera', 'Medina', 'Castro', 'Vargas', 'Guzmán', 'Velázquez', 'Muñoz',
  'Rojas', 'Contreras', 'Salazar', 'Luna', 'Ortega', 'Cortés', 'Guerrero', 'Estrada', 'Bautista', 'Delgado',
  'Soto', 'Navarro', 'Ríos', 'Mejía', 'Peña', 'Cabrera', 'Campos', 'Vega', 'Fuentes', 'Carrillo',
  'Sandoval', 'Espinoza', 'Ibarra', 'Valdez', 'León', 'Núñez', 'Acosta', 'Zamora', 'Solís', 'Escobar',
  'Rangel', 'Montes', 'Lara', 'Ávila', 'Treviño', 'Garza', 'Villarreal', 'Benítez', 'Cervantes', 'Orozco',
];

const BLOCK_REASONS = ['Invitación cancelada', 'Pago pendiente', 'Credencial reportada como extraviada', 'Registro duplicado dado de baja'];

/** PRNG mulberry32: rápido y reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateGuests(count = 10000, seed = 2026) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const category = () => {
    let r = rnd() * 100;
    for (const [key, weight] of CATEGORY_WEIGHTS) {
      r -= weight;
      if (r < 0) return key;
    }
    return 'general';
  };

  const guests = new Array(count);
  for (let i = 0; i < count; i++) {
    const pool = rnd() < 0.5 ? FIRST_F : FIRST_M;
    let firstName = pick(pool);
    if (rnd() < 0.28) {
      const second = pick(pool);
      if (second !== firstName) firstName += ` ${second}`;
    }
    const lastName = `${pick(LAST)} ${pick(LAST)}`;
    const cat = category();
    const table = cat === 'vip' ? 1 + Math.floor(rnd() * 12) : cat === 'general' ? 13 + Math.floor(rnd() * 138) : null;
    const blocked = rnd() < 0.015;
    guests[i] = {
      folio: String(100001 + i),
      firstName,
      lastName,
      category: cat,
      table,
      blocked,
      blockedReason: blocked ? pick(BLOCK_REASONS) : null,
    };
  }
  return guests;
}
