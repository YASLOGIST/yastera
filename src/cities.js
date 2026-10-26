import { latLngToVector3 } from './geo.js';
import * as THREE from 'three';

/**
 * @typedef {object} CityData
 * @property {string} id
 * @property {string} name
 * @property {string} nameAr
 * @property {string} country
 * @property {string} countryAr
 * @property {number} lat
 * @property {number} lng
 * @property {number} altitude
 * @property {string} population
 * @property {string} elevation
 * @property {string} timeZone IANA time-zone identifier
 * @property {string} sector
 * @property {string} sectorAr
 * @property {string} description
 * @property {string} descriptionAr
 * @property {string[]} landmarks
 */

/** @type {ReadonlyArray<CityData>} */
export const CITIES = Object.freeze([
  {
    id: 'cairo',
    name: 'Cairo',
    nameAr: 'القاهرة',
    country: 'Egypt',
    countryAr: 'مصر',
    lat: 30.0444,
    lng: 31.2357,
    altitude: 1.026,
    population: '22.1M',
    elevation: '23 m',
    timeZone: 'Africa/Cairo',
    sector: 'North Africa & Middle East',
    sectorAr: 'شمال أفريقيا والشرق الأوسط',
    description: 'Metropolitan hub of the Nile delta; historic center of trade with ancient and modern infrastructural nodes.',
    descriptionAr: 'عاصمة مصر وقلب دلتا النيل؛ ملتقى الحضارات ومركز التجارة الإقليمي مع شبكة عمرانية متطورة.',
    landmarks: ['Nile River Corridor', 'Giza Plateau', 'New Administrative Capital'],
  },
  {
    id: 'riyadh',
    name: 'Riyadh',
    nameAr: 'الرياض',
    country: 'Saudi Arabia',
    countryAr: 'المملكة العربية السعودية',
    lat: 24.7136,
    lng: 46.6753,
    altitude: 1.028,
    population: '7.8M',
    elevation: '612 m',
    timeZone: 'Asia/Riyadh',
    sector: 'Arabian Peninsula',
    sectorAr: 'شبه الجزيرة العربية',
    description: 'High-altitude desert metropolis; premier financial and cultural center of the Arabian Peninsula.',
    descriptionAr: 'عاصمة المملكة ومركزها المالي والسياسي؛ مدينة حديثة متسارعة النمو وسط هضبة نجد.',
    landmarks: ['Kingdom Centre', 'KAFD Financial District', 'Wadi Hanifa'],
  },
  {
    id: 'dubai',
    name: 'Dubai',
    nameAr: 'دبي',
    country: 'UAE',
    countryAr: 'الإمارات العربية المتحدة',
    lat: 25.2048,
    lng: 55.2708,
    altitude: 1.024,
    population: '3.6M',
    elevation: '5 m',
    timeZone: 'Asia/Dubai',
    sector: 'Persian Gulf Global Hub',
    sectorAr: 'الخليج العربي ومركز الطيران العالمي',
    description: 'Global aviation and maritime nexus; renowned for architectural superstructures and coastal infrastructure.',
    descriptionAr: 'مركز عالمي للتجارة والسياحة والطيران؛ تشتهر بناطحات السحاب والأرخبيلات الاصطناعية على الساحل.',
    landmarks: ['Burj Khalifa', 'Palm Jumeirah', 'Dubai Creek'],
  },
  {
    id: 'tokyo',
    name: 'Tokyo',
    nameAr: 'طوكيو',
    country: 'Japan',
    countryAr: 'اليابان',
    lat: 35.6762,
    lng: 139.6503,
    altitude: 1.026,
    population: '37.4M',
    elevation: '40 m',
    timeZone: 'Asia/Tokyo',
    sector: 'East Asia Mega-Metropolis',
    sectorAr: 'شرق آسيا وأكبر مجمع حضري في العالم',
    description: 'The world’s most populous metropolitan area; cutting-edge technological and economic epicenter.',
    descriptionAr: 'المركز الاقتصادي والتكنولوجي لليابان؛ عاصمة عالمية تمتاز بكثافة الأضواء الليلية وشبكات النقل الدقيقة.',
    landmarks: ['Tokyo Bay', 'Shinjuku Skyscraper Grid', 'Sumida River Basin'],
  },
  {
    id: 'new-york',
    name: 'New York',
    nameAr: 'نيويورك',
    country: 'United States',
    countryAr: 'الولايات المتحدة الأمريكية',
    lat: 40.7128,
    lng: -74.006,
    altitude: 1.025,
    population: '19.8M',
    elevation: '10 m',
    timeZone: 'America/New_York',
    sector: 'North American Atlantic Gateway',
    sectorAr: 'الساحل الشرقي لأمريكا الشمالية',
    description: 'Global financial capital and coastal metropolis flanked by the Hudson and East rivers.',
    descriptionAr: 'العاصمة المالية العالمية وميناء المحيط الأطلسي المحاط بنهري هادسن وإيست.',
    landmarks: ['Manhattan Peninsula', 'Hudson River', 'New York Harbor'],
  },
  {
    id: 'london',
    name: 'London',
    nameAr: 'لندن',
    country: 'United Kingdom',
    countryAr: 'المملكة المتحدة',
    lat: 51.5074,
    lng: -0.1278,
    altitude: 1.025,
    population: '9.7M',
    elevation: '11 m',
    timeZone: 'Europe/London',
    sector: 'Western Europe Financial Nexus',
    sectorAr: 'غرب أوروبا والمركز المالي العالمي',
    description: 'Historic settlement on the River Thames; primary European hub for global commerce and international transit.',
    descriptionAr: 'عاصمة بريطانيا ومحور التجارة العالمية الواقع على نهر التيمز وخط غرينتش.',
    landmarks: ['Thames Estuary', 'City Financial District', 'Greenwich Meridian'],
  },
  {
    id: 'paris',
    name: 'Paris',
    nameAr: 'باريس',
    country: 'France',
    countryAr: 'فرنسا',
    lat: 48.8566,
    lng: 2.3522,
    altitude: 1.025,
    population: '11.2M',
    elevation: '35 m',
    timeZone: 'Europe/Paris',
    sector: 'Western Europe Cultural Hub',
    sectorAr: 'غرب أوروبا وعاصمة الثقافة والعلوم',
    description: 'Circular planned metropolis straddling the Seine river basin; central node of Western European rail and road networks.',
    descriptionAr: 'عاصمة النور الواقعة على حوض نهر السين؛ ملتقى شبكات الطرق والمواصلات الأوروبية.',
    landmarks: ['Seine River Basin', 'Eiffel Axis', 'La Défense Modern Core'],
  },
  {
    id: 'singapore',
    name: 'Singapore',
    nameAr: 'سنغافورة',
    country: 'Singapore',
    countryAr: 'سنغافورة',
    lat: 1.3521,
    lng: 103.8198,
    altitude: 1.022,
    population: '5.9M',
    elevation: '15 m',
    timeZone: 'Asia/Singapore',
    sector: 'Strait of Malacca Maritime Chokepoint',
    sectorAr: 'مضيق ملقا وأهم ممر ملاحي في آسيا',
    description: 'Island city-state at the southern tip of the Malay Peninsula; one of the busiest maritime transshipment ports on Earth.',
    descriptionAr: 'جزيرة ومدينة-دولة على مضيق ملقا؛ من أنشط الموانئ البحرية والمراكز المالية في العالم.',
    landmarks: ['Marina Bay Core', 'Singapore Strait', 'Jurong Maritime Port'],
  },
  {
    id: 'shanghai',
    name: 'Shanghai',
    nameAr: 'شنغهاي',
    country: 'China',
    countryAr: 'الصين',
    lat: 31.2304,
    lng: 121.4737,
    altitude: 1.026,
    population: '28.5M',
    elevation: '4 m',
    timeZone: 'Asia/Shanghai',
    sector: 'Yangtze River Delta Maritime Port',
    sectorAr: 'دلتا نهر اليانغتسي والعملاق الصناعي',
    description: 'Massive coastal metropolis and world’s busiest container port on the East China Sea.',
    descriptionAr: 'أكبر مدينة صينية وأنشط ميناء حاويات في العالم؛ تقع على مصب نهر اليانغتسي.',
    landmarks: ['Pudong Skyscraper Core', 'Huangpu River', 'Yangtze River Estuary'],
  },
  {
    id: 'los-angeles',
    name: 'Los Angeles',
    nameAr: 'لوس أنجلوس',
    country: 'United States',
    countryAr: 'الولايات المتحدة الأمريكية',
    lat: 34.0522,
    lng: -118.2437,
    altitude: 1.026,
    population: '12.5M',
    elevation: '71 m',
    timeZone: 'America/Los_Angeles',
    sector: 'Pacific Rim Gateway',
    sectorAr: 'الساحل الغربي وحوض المحيط الهادئ',
    description: 'Expansive coastal basin bounded by the San Gabriel Mountains and the Pacific Ocean.',
    descriptionAr: 'كبرى مدن الساحل الغربي الأمريكي؛ تمتد بين جبال سان غابرييل والمحيط الهادئ بشبكة طرق شاسعة.',
    landmarks: ['Los Angeles Basin', 'Santa Monica Bay', 'Long Beach Harbor'],
  },
  {
    id: 'rio',
    name: 'Rio de Janeiro',
    nameAr: 'ريو دي جانيرو',
    country: 'Brazil',
    countryAr: 'البرازيل',
    lat: -22.9068,
    lng: -43.1729,
    altitude: 1.025,
    population: '13.6M',
    elevation: '2 m',
    timeZone: 'America/Sao_Paulo',
    sector: 'South Atlantic Coastal Hub',
    sectorAr: 'ساحل المحيط الأطلسي الجنوبي',
    description: 'Dramatic coastal topography nestled between Guanabara Bay and steep Atlantic rainforest granite peaks.',
    descriptionAr: 'مدينة ساحلية برازيلية تشتهر بتضاريس جبال الغرانيت وغابات الأطلسي المحيطة بخليج جوانابارا.',
    landmarks: ['Guanabara Bay', 'Sugarloaf Peak', 'Copacabana Shoreline'],
  },
  {
    id: 'cape-town',
    name: 'Cape Town',
    nameAr: 'كيب تاون',
    country: 'South Africa',
    countryAr: 'جنوب أفريقيا',
    lat: -33.9249,
    lng: 18.4241,
    altitude: 1.025,
    population: '4.8M',
    elevation: '25 m',
    timeZone: 'Africa/Johannesburg',
    sector: 'Cape of Good Hope Maritime Route',
    sectorAr: 'رأس الرجاء الصالح والمحيطين',
    description: 'Iconic coastal city situated at the convergence of the Atlantic and Indian oceans beneath Table Mountain.',
    descriptionAr: 'ملتقى المحيطين الأطلسي والهندي عند رأس الرجاء الصالح وأسفل جبل الطاولة الشهير.',
    landmarks: ['Table Mountain Plateau', 'Table Bay Harbor', 'Cape Peninsula'],
  },
]);

/**
 * Formats the current time in a city's IANA time zone. Unlike a stored UTC
 * offset, the zone database accounts for daylight-saving rules and fractional
 * offsets, which change by date and jurisdiction.
 * @param {CityData} city
 * @param {Date} [now]
 * @returns {string} e.g. "8:36 PM GMT+3"
 */
const localTimeFormatters = new Map();

export function getCityLocalTime(city, now = new Date()) {
  let formatter = localTimeFormatters.get(city.timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: city.timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'shortOffset',
    });
    localTimeFormatters.set(city.timeZone, formatter);
  }
  return formatter.format(now);
}
