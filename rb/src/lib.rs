use std::{
    cell::RefCell,
    collections::HashMap,
    fs::create_dir_all,
    path::{Path, PathBuf},
    rc::Rc,
    sync::Arc,
};

use swc::{
    config::{Config, JscConfig, Options},
    Compiler,
};
use swc_atoms::Atom;
use swc_common::{
    errors::{ColorConfig, Handler},
    SourceMap,
};
use swc_ecma_ast::{EsVersion, ImportDecl, Module, Program};

use swc_ecma_parser::parse_file_as_module;
use swc_ecma_visit::Visit;

const TARGET_ES_VERSION: EsVersion = EsVersion::Es5;

pub struct Bundler {
    /// Interner for `(FileName, start_loc, end_loc)`
    cm: Arc<SourceMap>,
    compiler: Compiler,

    entry_file_path: PathBuf,
    /// PQueue
    process_queue: ProcessQueue,
    asset_graph: HashMap<PathBuf, Rc<Asset>>,
    cur_id: u64,
}

impl Bundler {
    pub fn new(entry_file_path: PathBuf) -> Self {
        let cm = Arc::new(SourceMap::default());
        let compiler = Compiler::new(cm.clone());
        Self {
            cm,
            compiler,
            entry_file_path,
            process_queue: Default::default(),
            asset_graph: Default::default(),
            cur_id: Default::default(),
        }
    }

    pub fn bundle(&mut self) {
        self.process_assets();
        self.package_assets_into_bundles();
    }

    fn process_assets(&mut self) {
        self.create_asset(self.entry_file_path.clone());

        while let Some(asset) = self.process_queue.queue.pop() {
            self.process_asset(asset);
        }
    }

    fn add_to_process_queue(&mut self, asset: Rc<Asset>) {
        self.process_queue.add(asset);
    }

    fn create_asset(&mut self, path: PathBuf) -> Rc<Asset> {
        let id = self.cur_id;
        self.cur_id += 1;

        let asset = Rc::new(Asset {
            id,
            path: path.clone(),
            code: Default::default(),
            dependency_map: Default::default(),
        });
        self.asset_graph.insert(path, asset.clone());
        self.add_to_process_queue(asset.clone());
        return asset;
    }

    fn process_asset(&mut self, asset: Rc<Asset>) {
        let path = asset.path.clone();
        let fm = self.cm.load_file(&path).expect("failed to load file");
        let ast = parse_file_as_module(
            &fm,
            Default::default(),
            EsVersion::latest(),
            None,
            &mut vec![],
        )
        .expect("failed to parse file");

        let deps = find_imports(&ast);

        let mut dependency_map = HashMap::default();

        for module_request in deps {
            let src_dir = path.parent().unwrap();
            let dependency_path = resolve_from(src_dir, &module_request);

            let dependency_asset = match self.asset_graph.get(&dependency_path) {
                Some(e) => e.clone(),
                None => self.create_asset(dependency_path),
            };

            dependency_map.insert(module_request, dependency_asset.clone());
        }

        let code = self.print_js(ast);

        *asset.code.borrow_mut() = code;
        *asset.dependency_map.borrow_mut() = dependency_map;
    }

    fn package_assets_into_bundles(&mut self) -> String {
        let mut modules = String::new();

        self.asset_graph.iter().for_each(|(_, asset)| {
            let mut mapping = HashMap::new();
            asset
                .dependency_map
                .borrow()
                .iter()
                .for_each(|(specifier, dependency)| {
                    mapping.insert(specifier.clone(), dependency.id);
                });

            let mapping_json = serde_json::to_string(&mapping).unwrap();

            let code = asset.code.borrow();
            modules.push_str(&format!(
                "{}: [
                function (require, module, exports) {{
                  {}
                }},
                {},
              ],",
                asset.id, code, mapping_json
            ));
        });

        let result = format!(
            "
        (function(modules) {{
          function require(id) {{
            const [fn, mapping] = modules[id];
  
            function localRequire(name) {{
              return require(mapping[name]);
            }}
  
            const module = {{ exports : {{}} }};
  
            fn(localRequire, module, module.exports);
  
            return module.exports;
          }}
  
          require(0);
        }})({})
        ",
            modules
        );

        create_dir_all("dist").expect("failed to create dist directory");
        std::fs::write("dist/bundle.js", &result).expect("failed to write bundle.js");

        return result;
    }

    fn print_js(&mut self, m: Module) -> String {
        let h = Handler::with_tty_emitter(ColorConfig::Always, true, false, Some(self.cm.clone()));
        let m = self
            .compiler
            .process_js(
                &h,
                Program::Module(m.clone()),
                &Options {
                    config: Config {
                        jsc: JscConfig {
                            target: Some(TARGET_ES_VERSION),
                            ..Default::default()
                        },
                        module: Some(swc::config::ModuleConfig::CommonJs(
                            swc_ecma_transforms::modules::common_js::Config {
                                no_interop: true,
                                ..Default::default()
                            },
                        )),
                        ..Default::default()
                    },
                    ..Default::default()
                },
            )
            .unwrap();

        m.code
    }
}

fn resolve_from(path: &Path, specifier: &str) -> PathBuf {
    let resolver = oxc_resolver::Resolver::new(Default::default());
    let r = resolver.resolve(path, &specifier).unwrap_or_else(|err| {
        panic!(
            "failed to resolve specifier: {} from {}: {:?}",
            specifier,
            path.display(),
            err
        )
    });

    r.path().to_path_buf()
}

fn find_imports(ast: &Module) -> Vec<Atom> {
    let mut v = ImportVisitor { imports: vec![] };
    v.visit_module(ast);
    v.imports
}

struct ImportVisitor {
    imports: Vec<Atom>,
}

impl Visit for ImportVisitor {
    fn visit_import_decl(&mut self, node: &ImportDecl) {
        self.imports.push(node.src.value.clone());
    }
}

#[derive(Debug)]
struct Asset {
    id: u64,
    path: PathBuf,

    code: RefCell<String>,
    dependency_map: RefCell<HashMap<Atom, Rc<Asset>>>,
}

#[derive(Debug, Default)]
struct ProcessQueue {
    queue: Vec<Rc<Asset>>,
}

impl ProcessQueue {
    fn add(&mut self, asset: Rc<Asset>) {
        self.queue.push(asset);
    }
}
