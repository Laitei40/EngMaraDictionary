-- ============================================================
-- English ⇄ Mara Dictionary — Seed Data (Expanded)
-- 
-- Standard Mara (Lakher) Vocabulary
-- Note: 'aw' represents the open o sound, 'â' for long a.
-- ============================================================

-- Clear existing data to prevent duplicates when re-seeding
DELETE FROM dictionary;
DELETE FROM sqlite_sequence WHERE name='dictionary';

INSERT INTO dictionary (english_word, mara_word, part_of_speech, definition, example_sentence) VALUES
  -- Common Greetings & Basics
  ('hello',        'chibai',          'interjection', 'A common greeting.',                          'Chibai, na a aw ma? (Hello, how are you?)'),
  ('how are you',  'na a aw ma',      'phrase',     'Inquiry about someone''s well-being.',          'Na a aw ma? (How are you?)'),
  ('I am fine',    'ei a aw na',      'phrase',     'Response to how are you.',                    'Ei a aw na. (I am fine.)'),
  ('thank you',    'ei chhay hme',    'phrase',     'Expression of gratitude.',                    'Ei chhay hme! (Thank you!)'),
  ('yes',          'y',               'particle',   'Affirmative response.',                       'Y, ei vaw chhy. (Yes, I will go.)'),
  ('no',           'hrei',            'particle',   'Negative response.',                          'Hrei, ei vaw chhy vei. (No, I won''t go.)'),
  ('name',         'moh',             'noun',       'A word by which a person is known.',          'Na moh khâ a ta? (What is your name?)'),

  -- Nature & Elements
  ('water',        'ti',              'noun',       'Clear liquid essential for life.',            'Ti ei dong khoh. (I want to drink water.)'),
  ('fire',         'mei',             'noun',       'Combustion producing heat and light.',        'Mei a kâ. (The fire is burning.)'),
  ('wind',         'thli',            'noun',       'Moving air.',                                 'Thli a pathli ngaitay. (The wind blows hard.)'),
  ('earth',        'leilô',           'noun',       'Soil or ground.',                             'Leilô a phâ. (The soil is good.)'),
  ('sky',          'vâ',              'noun',       'The upper atmosphere.',                       'Vâ a ki. (The sky is blue/clear.)'),
  ('sun',          'ni',              'noun',       'The star around which earth orbits.',         'Ni a chhu. (The sun rises.)'),
  ('moon',         'thlâ',            'noun',       'Natural satellite of the earth.',             'Zâ ta thlâ a khai. (The moon shines at night.)'),
  ('star',         'awsi',            'noun',       'A fixed luminous point in the night sky.',    'Awsi a hluh ngaitay. (There are many stars.)'),
  ('river',        'chavah',          'noun',       'A large natural stream of water.',            'Chavah liata lå ei vaw pa. (I caught fish in the river.)'),
  ('mountain',     'tlâh',            'noun',       'Large natural elevation of earth.',           'Tlâh la a sâh ngaitay. (That mountain is very high.)'),
  ('forest',       'ram',             'noun',       'Large area covered chiefly with trees.',      'Ram liata sa a y. (There are animals in the forest.)'),
  ('stone',        'alô',             'noun',       'Hard solid mineral matter.',                  'Alô he a chru. (This stone is hard.)'),

  -- People & Family
  ('man',          'chapaw',          'noun',       'An adult male human.',                        'Chapaw pa kha. (One man.)'),
  ('woman',        'chanô',           'noun',       'An adult female human.',                      'Chanô phâ pa a châ. (She is a good woman.)'),
  ('father',       'paw',             'noun',       'Male parent.',                                'Ei paw he loh a phâ. (My father is kind.)'),
  ('mother',       'nô',              'noun',       'Female parent.',                              'Ei nô ei ky a pachhâ. (I love my mother.)'),
  ('child',        'hawta',           'noun',       'A young human being.',                        'Hawta zy ama chai. (The children are playing.)'),
  ('boy',          'hawti chapaw',    'noun',       'A male child.',                               'Hawti chapaw a rao. (The boy runs.)'),
  ('girl',         'hawti chanô',     'noun',       'A female child.',                             'Hawti chanô a la. (The girl is dancing.)'),
  ('friend',       'viasa',           'noun',       'A person with whom one shares affection.',    'Ei viasa phâ chaipâ. (My best friend.)'),

  -- Body Parts
  ('head',         'lu',              'noun',       'Upper part of the human body.',               'Ei lu a pasâ. (My head hurts.)'),
  ('eye',          'mo',              'noun',       'Organ of sight.',                             'Mo thôh pa. (Beautiful eyes.)'),
  ('ear',          'nah',             'noun',       'Organ of hearing.',                           'Ei nah a paki. (My ears are deaf/blocked.)'),
  ('nose',         'phao',            'noun',       'Organ of smell.',                             'Ei phao a pasâ. (My nose hurts.)'),
  ('mouth',        'pakah',           'noun',       'Opening for eating and speaking.',            'Na pakah a chhy. (Your mouth is small.)'),
  ('hand',         'ku',              'noun',       'End part of the arm.',                        'Na ku pasi. (Wash your hands.)'),
  ('leg',          'phei',            'noun',       'Limb used for walking.',                      'Ei phei a chhoru. (My leg is broken.)'),
  
  -- Home & Daily Life
  ('house',        'o',               'noun',       'Building for habitation.',                    'Keimo o a lai. (Our house is big.)'),
  ('door',         'ochhi',           'noun',       'Entryway to a house.',                        'Ochhi pahy. (Open the door.)'),
  ('food',         'pati',            'noun',       'Substance consumed for nutrition.',           'Pati nie. (Eat food.)'),
  ('rice',         'sâ',              'noun',       'Cooked rice (staple food).',                  'Sâ na nie haw ma? (Have you eaten rice?)'),
  ('meat',         'sa',              'noun',       'Flesh of an animal as food.',                 'Sa ei ngiâ. (I like meat.)'),
  ('clothes',      'chysia',          'noun',       'Items worn to cover the body.',               'Chysia thieh pa. (New clothes.)'),

  -- Animals
  ('dog',          'ui',              'noun',       'A domesticated carnivorous mammal.',          'Uipa a huh. (The dog barks.)'),
  ('cat',          'châ',             'noun',       'Small domesticated feline.',                  'Châ ta yu a kho. (The cat catches a rat.)'),
  ('pig',          'vo',              'noun',       'Omnivorous domesticated hoofed mammal.',      'Vo a thau. (The pig is fat.)'),
  ('chicken',      'vâ',              'noun',       'Domestic fowl.',                              'Vâ aw. (Chicken egg.)'),
  ('fish',         'lâ',              'noun',       'Aquatic animal.',                             'Lâ a hlao. (The fish is swimming.)'),
  ('cow',          'sia',             'noun',       'Domesticated bovine animal.',                 'Sia hnaw. (Cow milk.)'),
  ('bird',         'pavâ',            'noun',       'Feathered winged animal.',                    'Pavâ a zu. (The bird flies.)'),

  -- Verbs
  ('eat',          'nie',             'verb',       'To consume food.',                            'Amâ nie hai. (They are eating.)'),
  ('drink',        'dong',            'verb',       'To consume liquid.',                          'Ti dong. (Drink water.)'),
  ('sleep',        'mô',              'verb',       'To rest in sleep.',                           'A mô haw. (He has slept.)'),
  ('go',           'sie',             'verb',       'To move to another place.',                   'Khatai na sie aw? (Where will you go?)'),
  ('come',         'vy',              'verb',       'To approach.',                                'He liata vy. (Come here.)'),
  ('run',          'rao',             'verb',       'To move at a speed faster than walking.',     'A rao parah. (Run fast.)'),
  ('walk',         'pâsâ',            'verb',       'To move at a regular pace.',                  'A pâsâ. (He is walking.)'),
  ('sit',          'ty',              'verb',       'To be in a seated position.',                 'He liata ty. (Sit here.)'),
  ('stand',        'duah',            'verb',       'To modify one''s position to upright.',       'A duah. (He is standing.)'),
  ('speak',        'reih',            'verb',       'To say words.',                               'Mara reih ta reih. (Speak in Mara.)'),
  ('look',         'moh',             'verb',       'To direct one''s gaze.',                      'He liana he moh. (Look at this.)'),
  ('love',         'kyhpachhâ',       'verb',       'To have deep affection.',                     'Ei ky cha pachhâ. (I love you.)'),
  ('fear',         'chi',             'verb',       'To be afraid.',                               'Chi kha. (Do not fear.)'),

  -- Adjectives
  ('good',         'phâ',             'adjective',  'High quality.',                               'A phâ kaw. (It is very good.)'),
  ('bad',          'pha lei',         'adjective',  'Low quality.',                                'A pha lei. (It is bad.)'),
  ('big',          'lai',             'adjective',  'Large size.',                                 'O lai pa. (Big house.)'),
  ('small',        'chhy',            'adjective',  'Little size.',                                'O chhy pa. (Small house.)'),
  ('hot',          'lalô',            'adjective',  'High temperature.',                           'Ni a lalô. (The sun is hot.)'),
  ('cold',         'bi',              'adjective',  'Low temperature.',                            'Ti a bi. (The water is cold.)'),
  ('beautiful',    'ngiâ',            'adjective',  'Pleasing to the senses.',                     'Nô ngiâ pa. (Beautiful woman.)'),
  ('happy',        'aly',             'adjective',  'Feeling enjoyment.',                          'Ei aly kaw. (I am very happy.)'),
  ('sad',          'pachhi',          'adjective',  'Feeling sorrow.',                             'Ei pachhi. (I am sad.)'),

  -- Numbers
  ('one',          'kha',             'number',     'The number 1.',                               'Sia kha. (One cow.)'),
  ('two',          'no',              'number',     'The number 2.',                               'Sia no. (Two cows.)'),
  ('three',        'thô',             'number',     'The number 3.',                               'Sia thô. (Three cows.)'),
  ('four',         'pali',            'number',     'The number 4.',                               'Sia pali. (Four cows.)'),
  ('five',         'pangaw',          'number',     'The number 5.',                               'Sia pangaw. (Five cows.)'),
  ('ten',          'hraw',            'number',     'The number 10.',                              'Sia hraw. (Ten cows.)');
