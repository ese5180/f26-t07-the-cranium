# The Mixxx Zephyr engine, for the host tests and the Zephyr application.
#
#   include(engine/engine.cmake)
#   mz_add_engine(<target> <python>)
#
# adds the engine sources and include directory to <target>, and generates the
# DDJ-FLX4 mapping tables from the Mixxx XML with <python>.

set(MZ_ENGINE_DIR ${CMAKE_CURRENT_LIST_DIR} CACHE INTERNAL "Mixxx Zephyr engine")

function(mz_add_engine target python)
  set(root ${MZ_ENGINE_DIR}/..)
  set(generated_dir ${CMAKE_CURRENT_BINARY_DIR}/mz_generated)
  set(mapping_cpp ${generated_dir}/flx4_mapping.cpp)

  add_custom_command(
    OUTPUT ${mapping_cpp}
    COMMAND ${CMAKE_COMMAND} -E make_directory ${generated_dir}
    COMMAND ${python} ${root}/tools/gen_mapping.py
            --xml ${root}/mappings/Pioneer-DDJ-FLX4.midi.xml
            --symbol kPioneerDdjFlx4Mapping
            --script-prefix PioneerDDJFLX4
            --out ${mapping_cpp}
    DEPENDS ${root}/tools/gen_mapping.py ${root}/mappings/Pioneer-DDJ-FLX4.midi.xml
    COMMENT "Generating the DDJ-FLX4 mapping from the Mixxx XML"
    VERBATIM)

  target_sources(${target} PRIVATE
    ${MZ_ENGINE_DIR}/src/biquad.cpp
    ${MZ_ENGINE_DIR}/src/caching_reader.cpp
    ${MZ_ENGINE_DIR}/src/control_behavior.cpp
    ${MZ_ENGINE_DIR}/src/deck.cpp
    ${MZ_ENGINE_DIR}/src/engine.cpp
    ${MZ_ENGINE_DIR}/src/eq.cpp
    ${MZ_ENGINE_DIR}/src/filter_effect.cpp
    ${MZ_ENGINE_DIR}/src/midi.cpp
    ${MZ_ENGINE_DIR}/src/mixer.cpp
    ${MZ_ENGINE_DIR}/src/scratch.cpp
    ${MZ_ENGINE_DIR}/src/wav_source.cpp
    ${MZ_ENGINE_DIR}/src/xfader.cpp
    ${mapping_cpp})
  target_include_directories(${target} PRIVATE ${MZ_ENGINE_DIR}/include)
endfunction()
