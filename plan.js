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
  // Filas de la cotización que no son una medición (títulos de columna, precios, condiciones y datos de pago).
  var RE_COMERCIAL = /^(metodolog|metodo de analisis|parametros? a analizar|determinacion|precio|total\b|entrega de resultados|la entrega|informe de resultado|facturacion|pago|informacion para|titular|banco|tipo cuenta|numero\b|cbu|n[o°º]?\s*cuit|los precios|ley n|muestras?\b)/;

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

  // Códigos de los métodos que SÍ están en la ficha (a diferencia de los alias, que son solo para reconocer filas).
  function p_codigosMetodo(catalogo) {
    catalogo.parametros.forEach(function (p) {
      p._metodoReal = (p.metodos || []).map(function (m) { return compacto(m.codigo); });
    });
  }

  // Códigos de método con forma de norma dentro de un texto: "NIOSH 7300", "OSHA ID 121", "EPA IO 2.3", "ISO 2631"...
  var RE_NORMA = /\b(NIOSH|OSHA(?:\s*ID)?|EPA(?:\s*(?:IO|SW-?846|CTM|M))?|ASTM|ISO|IRAM|UNE|SM|CH|NTP)[\s-]*([A-Z]?\d[\d.\-A-Za-z]*(?:\/\d+)?)/gi;
  function codigosDeNorma(texto) {
    var salida = [], m;
    RE_NORMA.lastIndex = 0;
    while ((m = RE_NORMA.exec(String(texto || ''))) !== null) {
      var visto = m[0].replace(/\s+/g, ' ').trim();
      if (salida.indexOf(visto) === -1) salida.push(visto);
    }
    return salida;
  }
  // Busca el código cotizado en el índice de la Biblioteca (acepta "IRAM 4062/2025" para "IRAM 4062").
  function resolverCodigo(ix, codigo) {
    var k = compacto(codigo), refs = ix.refs || {};
    if (refs[k]) return refs[k];
    var mejor = null;
    Object.keys(refs).forEach(function (kk) { if (k.indexOf(kk) === 0 && (!mejor || kk.length > mejor.length)) mejor = kk; });
    return mejor ? refs[mejor] : null;
  }

  function indexar(catalogo) {
    var porId = {};
    catalogo.parametros.forEach(function (p) {
      p._codigos = (p.codigos || []).map(compacto).filter(function (c) { return c.length >= 5; });
      p._frases = (p.frases || []).map(norm);
      porId[p.id] = p;
    });
    p_codigosMetodo(catalogo);
    return { cat: catalogo, porId: porId, ignorar: (catalogo.ignorar || []).map(norm), refs: catalogo.metodosRef || {} };
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
    if (RE_COMERCIAL.test(nombre)) { res.motivo = 'no es una medición'; res.ignorada = true; return res; }
    var todo = nombre + ' ' + norm(metodo);
    for (var k = 0; k < ix.ignorar.length; k++) {
      if (todo.indexOf(ix.ignorar[k]) !== -1) { res.ignorada = true; res.motivo = 'no es una medición'; return res; }
    }

    // lo que una persona ya confirmó vale más que cualquier cálculo
    var clave = claveFila(fila);
    if (correcciones && correcciones[clave] && ix.porId[correcciones[clave]]) {
      res.ficha = correcciones[clave]; res.confianza = 'confirmada'; res.motivo = 'confirmada por el equipo';
      return conMetodoCotizado(ix, res, metodo);
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
    return conMetodoCotizado(ix, res, metodo);
  }

  // Qué método se cotizó para la fila, si está en la Biblioteca y si es el mismo de la ficha de muestreo.
  function conMetodoCotizado(ix, res, metodo) {
    res.metodosCotizados = codigosDeNorma(metodo).map(function (c) {
      var ref = resolverCodigo(ix, c);
      return ref ? { codigo: c, enBiblioteca: true, ref: ref } : { codigo: c, enBiblioteca: false };
    });
    // ¿el método cotizado determina ese elemento? (lista de elementos de cada método)
    var tabla = ix.cat.analitosMetodo || {};
    var todos = {};
    Object.keys(tabla).forEach(function (m) { tabla[m].forEach(function (e) { todos[e] = true; }); });
    var elemento = Object.keys(todos).filter(function (e) { return contieneFrase(limpiarParametro(res.parametro), e); })[0];
    res.noCubre = [];
    if (elemento) {
      res.metodosCotizados.forEach(function (m) {
        var clave = Object.keys(tabla).filter(function (k) { return compacto(k) === compacto(m.ref ? m.ref.codigo : m.codigo); })[0];
        if (clave && tabla[clave].indexOf(elemento) === -1) {
          res.noCubre.push({ codigo: m.codigo, elemento: elemento,
            alternativas: Object.keys(tabla).filter(function (k) { return k !== clave && tabla[k].indexOf(elemento) !== -1 && ix.refs[compacto(k)]; }) });
        }
      });
    }
    var ficha = res.ficha ? ix.porId[res.ficha] : null;
    var reales = ficha ? (ficha._metodoReal || []) : [];
    // coincide: el método cotizado es uno de los que la ficha trae con datos de muestreo
    res.coincide = res.metodosCotizados.length === 0 ? null :
      res.metodosCotizados.some(function (m) { var k = compacto(m.codigo); return reales.some(function (r) { return k.indexOf(r) === 0; }); });
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

    var metodos = {}, procs = {}, legis = {}, eqIds = {}, cc = {}, discrepancias = [], avisosMetodo = [];
    // Los métodos del plan son los COTIZADOS (no los que trae la ficha): si no está en la Biblioteca se dice.
    filas.forEach(function (f) {
      (f.metodosCotizados || []).forEach(function (m) {
        var k = compacto(m.codigo);
        if (metodos[k]) return;
        metodos[k] = m.enBiblioteca ? Object.assign({}, m.ref, { codigoCotizado: m.codigo }) : { codigo: m.codigo, faltante: true };
      });
      (f.noCubre || []).forEach(function (n) { avisosMetodo.push(f.parametro + ': ' + n.codigo + ' no incluye ' + n.elemento + (n.alternativas.length ? '; sí lo determina ' + n.alternativas.join(' / ') : '') + '.'); });
      if (f.ficha && f.coincide === false) {
        discrepancias.push({ ficha: f.ficha, parametro: f.parametro, metodo: (f.metodosCotizados || []).map(function (m) { return m.codigo; }).join(' / '),
          enBiblioteca: (f.metodosCotizados || []).every(function (m) { return m.enBiblioteca; }) });
      }
    });
    fichas.forEach(function (p) {
      p.proc.forEach(function (m) { procs[m.codigo] = m; });
      p.legis.forEach(function (m) { legis[m.codigo] = m; });
      (p.equipos || []).forEach(function (e) { eqIds[e] = true; });
      if (p.cc) cc[p.cc] = true;
    });

    var porCal = {};
    (equiposCal || []).forEach(function (e) { porCal[e.id] = e; });
    var peor = null;
    var equipos = Object.keys(eqIds).map(function (id) {
      var nom = ix.cat.equipos[id];
      var def = { nombre: (nom && nom.nombre) || nom || id, cal: (ix.cat.equiposCal && ix.cat.equiposCal[id]) || (nom && nom.cal) || [] };
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
      metodos: Object.keys(metodos).map(function (k) { return metodos[k]; }), discrepancias: discrepancias, avisosMetodo: avisosMetodo,
      procedimientos: Object.keys(procs).map(function (k) { return procs[k]; }),
      legislacion: Object.keys(legis).map(function (k) { return legis[k]; }),
      equipos: equipos, estado: equipos.length ? (peor || 'sin_dato') : 'sin_equipo', planillasCC: Object.keys(cc),
      sinFicha: filas.filter(function (f) { return !f.ficha && !f.ignorada; }).length,
      dudosas: filas.filter(function (f) { return f.ficha && f.confianza === 'media'; }).length
    };
  }


  /* ---------------- muestreo compartido ----------------
     Dado el conjunto de fichas de un ítem, arma qué comparte medio de captación (filtro, tubo,
     instrumento) y cuáles no, con la razón. Todo es SUGERENCIA: lo decide el técnico. */
  function rangoCompartido(fichas, campo) {
    var lo = -Infinity, hi = Infinity, hay = false;
    fichas.forEach(function (p) {
      var r = p[campo];
      if (r && r.length === 2) { hay = true; lo = Math.max(lo, r[0]); hi = Math.min(hi, r[1]); }
    });
    return hay ? { lo: lo, hi: hi, ok: lo <= hi } : null;
  }
  function nf(n) { return Number(n).toLocaleString('es-AR', { maximumFractionDigits: 3 }); }

  function agruparMuestreo(ix, fichaIds, opc) {
    opc = opc || {};
    var jornada = opc.jornada > 0 ? opc.jornada : 480;
    var muestras = parseInt(opc.muestras, 10) > 0 ? parseInt(opc.muestras, 10) : 1;
    var M = ix.cat.muestreo || { medios: {}, fichaMedios: {}, notas: {}, explicaciones: [], redundantes: [] };
    var presentes = {};
    fichaIds.forEach(function (id) { if (ix.porId[id]) presentes[id] = true; });

    // lo que otro parámetro ya cubre no se muestrea aparte
    var redundantes = [];
    (M.redundantes || []).forEach(function (r) {
      if (presentes[r.a] && presentes[r.b]) { redundantes.push(r); delete presentes[r.a]; }
    });
    var ids = Object.keys(presentes);

    // 1) los que solo pueden ir en un medio lo fijan; los que admiten varios se suman a uno ya pedido
    var pedidos = {};
    ids.forEach(function (id) { var o = M.fichaMedios[id]; if (o && o.length === 1) pedidos[o[0]] = true; });
    var medioDe = {};
    ids.forEach(function (id) {
      var o = M.fichaMedios[id];
      if (!o || !o.length) { medioDe[id] = 'solo:' + id; return; }
      var elegido = o.filter(function (m) { return pedidos[m]; })[0] || o[0];
      medioDe[id] = elegido; pedidos[elegido] = true;
    });

    var porMedio = {}, orden = [];
    ids.forEach(function (id) {
      var m = medioDe[id];
      if (!porMedio[m]) { porMedio[m] = []; orden.push(m); }
      porMedio[m].push(ix.porId[id]);
    });

    var grupos = [];
    orden.forEach(function (mid) {
      var fichas = porMedio[mid];
      var def = M.medios[mid];
      var solo = mid.indexOf('solo:') === 0;
      var nombre = def ? def.nombre : (fichas[0].medio || fichas[0].nombre);
      var conCaudal = fichas.some(function (p) { return p.caudal; });
      var bomba = def ? def.bomba : conCaudal;
      var g = { medio: mid, nombre: nombre, fichas: fichas.map(function (p) { return p.id; }), nombresFichas: fichas.map(function (p) { return p.nombre; }),
        compartido: fichas.length > 1, bomba: bomba, avisos: [], notas: [], estado: 'ok' };

      if (bomba && conCaudal) {
        // Límite duro: el caudal (lo fija el equipo o el ciclón). Los rangos de volumen de los métodos son
        // de referencia según la concentración esperada: solo generan avisos.
        var q = rangoCompartido(fichas, 'caudal');
        var tFijos = fichas.map(function (p) { return p.tiempo; }).filter(Boolean);
        var t = tFijos.length ? Math.max.apply(null, tFijos) : jornada;
        g.tiempo = t;
        if (q && !q.ok) {
          g.estado = 'no_compatible';
          g.avisos.push('Los caudales de los métodos no se superponen (' + fichas.map(function (p) { return p.nombre + ': ' + (p.caudal ? nf(p.caudal[0]) + '–' + nf(p.caudal[1]) : 'sin dato') + ' L/min'; }).join(' · ') + '): hay que usar un medio para cada uno.');
        } else if (q) {
          g.caudal = { min: q.lo, max: q.hi };
          // caudal: el que deja el volumen dentro del rango de todos; si no hay, el más cercano
          var v = rangoCompartido(fichas, 'vol');
          var qIdeal = q.lo === q.hi ? q.lo : (q.lo + q.hi) / 2;
          if (v && v.ok && q.lo !== q.hi) {
            var a1 = Math.max(q.lo, v.lo / t), b1 = Math.min(q.hi, v.hi / t);
            qIdeal = a1 <= b1 ? (a1 + b1) / 2 : (v.hi / t < q.lo ? q.lo : q.hi);
          }
          qIdeal = Math.round(qIdeal * 1000) / 1000;
          var vol = Math.round(qIdeal * t * 10) / 10;
          g.sugerido = { caudal: qIdeal, tiempo: t, volumen: vol };
          if (tFijos.length) g.avisos.push('El tiempo (' + nf(t) + ' min) lo recomienda el método.');
          // contraste contra el rango de referencia de cada método
          fichas.forEach(function (p) {
            if (!p.vol) return;
            if (vol < p.vol[0]) g.avisos.push(p.nombre + ': con ' + nf(vol) + ' L no llega al volumen mínimo de referencia del método (' + nf(p.vol[0]) + ' L). Hace falta ' + nf(Math.ceil(p.vol[0] / q.hi)) + ' min como mínimo a ' + nf(q.hi) + ' L/min.');
            else if (vol > p.vol[1]) g.avisos.push(p.nombre + ': ' + nf(vol) + ' L supera el máximo de referencia (' + nf(p.vol[1]) + ' L, calculado para una concentración alta). Es válido si la concentración es baja; si no, se satura' + (!tFijos.length ? ' (o limitar el muestreo a ' + nf(Math.floor(p.vol[1] / q.lo)) + ' min a ' + nf(q.lo) + ' L/min)' : '') + '.');
          });
          var conMasa = fichas.filter(function (p) { return p.masa; })[0];
          if (conMasa) {
            g.concentracionMaxima = { valor: Math.round(conMasa.masa[1] / (vol / 1000) * 100) / 100, unidad: 'mg/m³' };
            g.avisos.push('Con ' + nf(vol) + ' L el filtro admite hasta ' + nf(conMasa.masa[1]) + ' mg de polvo: si la concentración supera ' + nf(g.concentracionMaxima.valor) + ' mg/m³ el filtro se satura y hay que cambiarlo durante la jornada.');
          }
        }
      }
      if (bomba && g.compartido && g.estado !== 'no_compatible' &&
          fichas.some(function (p) { return /Tabla/i.test((p.notas || '') + ' ' + (p.limite || '')); })) {
        g.avisos.push('Algunos métodos dan el caudal y el volumen según el compuesto o el elemento (Tabla del método): confirmar antes de fijar el tiempo.');
      }
      if (g.compartido || mid === 'directa' || mid === 'isocinetico') {
        (M.notas[mid] || []).forEach(function (n) { g.notas.push(n); });
      }
      // El plan se plantea con el método cotizado: si el cotizado no es el de la ficha, los datos son de referencia.
      (opc.discrepancias || []).forEach(function (d) {
        if (g.fichas.indexOf(d.ficha) === -1) return;
        var ficha = ix.porId[d.ficha];
        var base = (ficha.metodos || []).map(function (m) { return m.codigo; }).join(' / ') || 'otro método';
        g.avisos.push(d.parametro + ': se cotizó por ' + d.metodo + (d.enBiblioteca ? '' : ' (no está en la Biblioteca)') +
          '. El medio y el caudal de este grupo salen de ' + base + ': confirmar con el método cotizado antes de compartir el filtro.');
        g.provisional = true;
      });
      g.muestras = muestras;
      grupos.push(g);
    });

    // los que no pudieron compartir por caudal/volumen pasan a ir uno por uno
    var finales = [];
    grupos.forEach(function (g) {
      if (g.estado === 'no_compatible') {
        g.fichas.forEach(function (id, i) {
          var p = ix.porId[id];
          finales.push({ medio: g.medio, nombre: g.nombre, fichas: [id], nombresFichas: [p.nombre], compartido: false, bomba: g.bomba, avisos: i === 0 ? g.avisos : [], notas: [], estado: 'ok', muestras: muestras,
            caudal: p.caudal ? { min: p.caudal[0], max: p.caudal[1] } : null });
        });
      } else finales.push(g);
    });

    // por qué no comparten (solo pares presentes en el ítem y en grupos distintos)
    var grupoDe = {};
    finales.forEach(function (g, i) { g.fichas.forEach(function (id) { grupoDe[id] = i; }); });
    var noComparten = (M.explicaciones || []).filter(function (e) {
      return e.a in grupoDe && e.b in grupoDe && grupoDe[e.a] !== grupoDe[e.b];
    });

    var fisicos = finales.filter(function (g) { return g.medio !== 'directa'; });
    var sinCompartir = ids.filter(function (id) { return medioDe[id] !== 'directa'; }).length;
    var blancos = Math.max(2, Math.ceil(muestras * 0.1));
    return {
      grupos: finales, noComparten: noComparten, redundantes: redundantes, blancos: blancos, muestras: muestras,
      resumen: { mediosSinCompartir: sinCompartir, mediosCompartiendo: fisicos.length,
        bombas: finales.filter(function (g) { return g.bomba; }).length, jornada: jornada }
    };
  }

  function planDeServicio(ix, items, equiposCal, correcciones, hoy) {
    return (items || []).map(function (it) { return planDeItem(ix, it, equiposCal, correcciones, hoy); });
  }

  var API = { codigosDeNorma: codigosDeNorma, resolverCodigo: resolverCodigo, claveFila: claveFila, norm: norm, compacto: compacto, indexar: indexar, cruzarFila: cruzarFila, cruzarTitulo: cruzarTitulo,
    planDeItem: planDeItem, agruparMuestreo: agruparMuestreo, planDeServicio: planDeServicio, estadoEquipo: estadoEquipo };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else global.GHPlan = API;
})(typeof window !== 'undefined' ? window : this);
