/* Cruce de una cotización con el catálogo de la Biblioteca (GH Consultora).
   JS puro y sin dependencias: lo usan Seguimiento de Mediciones y la Biblioteca web.
   Entrada: catálogo (catalogo_web.json), filas de cotización [{parametro, metodologia}],
   equipos de Calibraciones. Salida: para cada fila, la ficha que le corresponde y con
   qué confianza; y por ítem, los métodos, procedimientos y equipos con su calibración. */
(function (global) {
  'use strict';

  function norm(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[´`'’]/g, '').replace(/\s+/g, ' ').trim();
  }
  // "NIOSH 0600." / "niosh-0600" / "NIOSH0600" -> "niosh0600"
  function compacto(s) { return norm(s).replace(/[^a-z0-9]/g, ''); }

  var RE_TOTAL = /^total( de muestras)?\s+/;

  function limpiarParametro(p) {
    var t = norm(p).replace(RE_TOTAL, '').replace(/[.:;]+$/, '').trim();
    return t;
  }

  // ¿la frase aparece como palabra(s) entera(s) dentro del texto?
  function contieneFrase(texto, frase) {
    var f = norm(frase);
    if (!f) return false;
    var i = -1;
    while ((i = texto.indexOf(f, i + 1)) !== -1) {
      var antes = i === 0 ? ' ' : texto.charAt(i - 1);
      var desp = i + f.length >= texto.length ? ' ' : texto.charAt(i + f.length);
      if (!/[a-z0-9]/.test(antes) && !/[a-z0-9]/.test(desp)) return true;
    }
    return false;
  }

  function indexar(catalogo) {
    var porId = {};
    catalogo.parametros.forEach(function (p) {
      p._codigos = (p.codigos || []).map(compacto).filter(function (c) { return c.length >= 5; });
      p._frases = (p.frases || []).map(norm);
      porId[p.id] = p;
    });
    return { cat: catalogo, porId: porId, ignorar: (catalogo.ignorar || []).map(norm) };
  }

  // Puntaje de una ficha para una fila. Un código de método vale más que una frase del
  // nombre; frases más largas valen más que cortas ("dioxido de azufre" > "co").
  function puntuar(p, nombre, metodoCompacto, textoCompacto) {
    var puntos = 0, porCodigo = false, porNombre = false;
    p._codigos.forEach(function (c) {
      if (metodoCompacto.indexOf(c) !== -1) { puntos += 10; porCodigo = true; }
    });
    var mejor = 0, largo = 0;
    p._frases.forEach(function (f) {
      if (contieneFrase(nombre, f) && f.length > largo) { largo = f.length; mejor = 4 + Math.min(f.length, 24) / 8; }
    });
    if (mejor) { puntos += mejor; porNombre = true; }
    return { puntos: puntos, porCodigo: porCodigo, porNombre: porNombre, largoFrase: largo };
  }

  // Clave con la que se recuerda una confirmación manual: nombre limpio + método compacto.
  function claveFila(fila) {
    return limpiarParametro(fila.parametro) + '||' + compacto(fila.metodologia);
  }

  // Cruza una fila. Devuelve {ficha, confianza, candidatas, motivo}.
  function cruzarFila(ix, fila, correcciones) {
    var nombreOriginal = String(fila.parametro || '');
    var nombre = limpiarParametro(nombreOriginal);
    var metodo = String(fila.metodologia || '');
    var res = { parametro: nombreOriginal.trim(), metodologia: metodo.trim(), ficha: null, confianza: 'ninguna', candidatas: [], motivo: '' };

    if (!nombre && !metodo) { res.motivo = 'vacía'; res.ignorada = true; return res; }
    var todo = nombre + ' ' + norm(metodo);
    for (var k = 0; k < ix.ignorar.length; k++) {
      if (todo.indexOf(ix.ignorar[k]) !== -1) { res.ignorada = true; res.motivo = 'no es una medición'; return res; }
    }

    // lo que una persona ya confirmó vale más que cualquier cálculo
    var clave = claveFila(fila);
    if (correcciones && correcciones[clave] && ix.porId[correcciones[clave]]) {
      res.ficha = correcciones[clave]; res.confianza = 'confirmada'; res.motivo = 'confirmada por el equipo';
      return res;
    }

    var metodoCompacto = compacto(metodo + ' ' + nombreOriginal);
    var cand = [];
    ix.cat.parametros.forEach(function (p) {
      var r = puntuar(p, nombre, metodoCompacto, '');
      if (r.puntos > 0) cand.push({ id: p.id, puntos: r.puntos, porCodigo: r.porCodigo, porNombre: r.porNombre, largoFrase: r.largoFrase });
    });
    cand.sort(function (a, b) { return b.puntos - a.puntos; });
    res.candidatas = cand.slice(0, 3).map(function (c) { return c.id; });
    if (!cand.length) { res.motivo = 'no hay ficha para este parámetro'; return res; }

    var top = cand[0], segundo = cand[1];
    res.ficha = top.id;
    if (top.porCodigo && top.porNombre) { res.confianza = 'alta'; res.motivo = 'coinciden el método y el nombre'; }
    else if (top.porCodigo) { res.confianza = 'alta'; res.motivo = 'por el código del método'; }
    else if (top.largoFrase >= 6) { res.confianza = 'alta'; res.motivo = 'por el nombre del parámetro'; }
    else { res.confianza = 'media'; res.motivo = 'nombre corto, conviene revisarlo'; }
    if (segundo && segundo.puntos >= top.puntos - 0.5 && segundo.id !== top.id) {
      res.confianza = 'media'; res.motivo = 'podría ser también: ' + segundo.id;
    }
    return res;
  }

  // Si la cotización no trae las filas (servicios viejos), se intenta con el título del ítem.
  function cruzarTitulo(ix, titulo) {
    var f = cruzarFila(ix, { parametro: titulo, metodologia: '' });
    if (f.ficha && f.confianza !== 'alta') f.confianza = 'media';
    f.motivo = f.ficha ? 'por el título del ítem' : f.motivo;
    return f;
  }

  var ORDEN = ['rojo', 'naranja', 'amarillo', 'gris', 'verde'];

  function estadoEquipo(eq, hoy) {
    if (!eq || !eq.fecha_venc) return { estado: 'gris', dias: null };
    var p = String(eq.fecha_venc).split('-');
    var dias = Math.round((new Date(+p[0], +p[1] - 1, +p[2]) - hoy) / 86400000);
    return { estado: dias <= 0 ? 'rojo' : dias <= 60 ? 'naranja' : dias <= 90 ? 'amarillo' : 'verde', dias: dias };
  }

  // Arma el plan técnico de un ítem de la cotización.
  // item: {titulo, muestras, filas:[{parametro,metodologia}]}; equiposCal: filas de CALIBRACIONES_DATA
  function planDeItem(ix, item, equiposCal, correcciones, hoy) {
    hoy = hoy || new Date(new Date().setHours(0, 0, 0, 0));
    var filas = (item.filas && item.filas.length ? item.filas.map(function (f) { return cruzarFila(ix, f, correcciones); })
      : [cruzarTitulo(ix, item.titulo)]);
    var vistas = {}, fichas = [];
    filas.forEach(function (f) {
      if (f.ficha && !vistas[f.ficha]) { vistas[f.ficha] = true; fichas.push(ix.porId[f.ficha]); }
    });

    var metodos = {}, procs = {}, legis = {}, eqIds = {}, cc = {};
    fichas.forEach(function (p) {
      p.metodos.forEach(function (m) { metodos[m.codigo] = m; });
      p.proc.forEach(function (m) { procs[m.codigo] = m; });
      p.legis.forEach(function (m) { legis[m.codigo] = m; });
      (p.equipos || []).forEach(function (e) { eqIds[e] = true; });
      if (p.cc) cc[p.cc] = true;
    });

    var porCal = {};
    (equiposCal || []).forEach(function (e) { porCal[e.id] = e; });
    var peor = null;
    var equipos = Object.keys(eqIds).map(function (id) {
      var def = ix.cat.equipos[id] || { nombre: id, cal: [] };
      var fisicos = (def.cal || []).map(function (cid) {
        var e = porCal[cid]; var st = estadoEquipo(e, hoy);
        return { id: cid, equipo: e ? e.equipo : cid, marca: e ? e.marca : '', modelo: e ? e.modelo : '', fecha_venc: e ? e.fecha_venc : null,
          certificado: e ? e.pdf_file_id : null, estado: e ? st.estado : 'gris', dias: st.dias };
      });
      var estado = !def.cal || !def.cal.length ? 'sin_dato' : fisicos.reduce(function (acc, e) {
        // con dos bombas físicas alcanza con que una esté vigente: se toma la mejor
        return acc === null || ORDEN.indexOf(e.estado) > ORDEN.indexOf(acc) ? e.estado : acc;
      }, null);
      if (estado && estado !== 'sin_dato' && (peor === null || ORDEN.indexOf(estado) < ORDEN.indexOf(peor))) peor = estado;
      return { id: id, nombre: def.nombre, estado: estado, fisicos: fisicos };
    });
    equipos.sort(function (a, b) { return ORDEN.indexOf(a.estado) - ORDEN.indexOf(b.estado); });

    return {
      titulo: item.titulo, muestras: item.muestras || '', filas: filas, fichas: fichas.map(function (p) { return p.id; }),
      metodos: Object.keys(metodos).map(function (k) { return metodos[k]; }),
      procedimientos: Object.keys(procs).map(function (k) { return procs[k]; }),
      legislacion: Object.keys(legis).map(function (k) { return legis[k]; }),
      equipos: equipos, estado: equipos.length ? (peor || 'sin_dato') : 'sin_equipo', planillasCC: Object.keys(cc),
      sinFicha: filas.filter(function (f) { return !f.ficha && !f.ignorada; }).length,
      dudosas: filas.filter(function (f) { return f.ficha && f.confianza === 'media'; }).length
    };
  }

  function planDeServicio(ix, items, equiposCal, correcciones, hoy) {
    return (items || []).map(function (it) { return planDeItem(ix, it, equiposCal, correcciones, hoy); });
  }

  var API = { claveFila: claveFila, norm: norm, compacto: compacto, indexar: indexar, cruzarFila: cruzarFila, cruzarTitulo: cruzarTitulo,
    planDeItem: planDeItem, planDeServicio: planDeServicio, estadoEquipo: estadoEquipo };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else global.GHPlan = API;
})(typeof window !== 'undefined' ? window : this);
