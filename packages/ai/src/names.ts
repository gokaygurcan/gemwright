const givenNames = [
  'Rowan',
  'Bram',
  'Owen',
  'Silas',
  'Emmett',
  'Tobin',
  'Ellis',
  'Callum',
  'Alden',
  'Corin',
  'Dorian',
  'Gareth',
  'Jasper',
  'Lucan',
  'Merrick',
  'Nolan',
  'Orin',
  'Perrin',
  'Quinn',
  'Ronan',
  'Stellan',
  'Tristan',
  'Wesley',
  'Finn',
  'Arthur',
  'Edwin',
  'Gavin',
  'Harlan',
  'Jonas',
  'Lachlan',
  'Martin',
  'Oscar'
];

const familyNames = [
  'Vale',
  'Reed',
  'Ash',
  'Beck',
  'Brook',
  'Byrne',
  'Cole',
  'Dale',
  'Drake',
  'Finch',
  'Ford',
  'Frost',
  'Gray',
  'Hale',
  'Hart',
  'Hayes',
  'Hill',
  'Holt',
  'Lake',
  'Lane',
  'Marsh',
  'Moss',
  'Oak',
  'Pike',
  'Quill',
  'Rook',
  'Shaw',
  'Stone',
  'Thorne',
  'Ward',
  'West',
  'Wren'
];

export function playerName(residentId: string, existingNames: Iterable<string>): string {
  const used = new Set([...existingNames].map((name) => name.toLowerCase()));
  let seed = 2166136261;
  for (const character of residentId) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  const capacity = givenNames.length * familyNames.length;
  for (let attempt = 0; attempt < capacity; attempt++) {
    const index = (seed + attempt) % capacity;
    const name = `${givenNames[Math.floor(index / familyNames.length)]} ${familyNames[index % familyNames.length]}`;
    if (!used.has(name.toLowerCase())) return name;
  }
  throw new Error('Player name pool exhausted; expand it before creating more residents');
}
